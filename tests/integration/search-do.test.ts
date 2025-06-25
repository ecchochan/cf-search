import { SearchIndexDO } from "@/durables";
import type { Document, DOStats, SearchResult } from "@/types";
import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Type for test documents that may have integer IDs
type TestDocument = Document | { id: number; content: string; [key: string]: unknown };

describe("SearchIndexDO Integration Tests", () => {
  // Helper function to get a DO instance with proper typing and unique naming
  const getPrimaryDO = (testName?: string): DurableObjectStub<SearchIndexDO> => {
    const uniqueName = testName ? `test-primary-${testName}-${Date.now()}` : `test-primary-${Date.now()}`;
    const id = env.PRIMARY_INDEX_DO.idFromName(uniqueName);
    return env.PRIMARY_INDEX_DO.get(id) as DurableObjectStub<SearchIndexDO>;
  };

  describe("Initialization and Configuration", () => {
    it("should initialize with empty database", async () => {
      const stub = getPrimaryDO("init-empty");

      // Test HTTP endpoint for external API
      const response = await stub.fetch("http://do/stats");
      expect(response.status).toBe(200);

      const stats = (await response.json()) as DOStats;
      expect(stats.count).toBe(0);
      expect(stats.estimatedSize).toBeGreaterThanOrEqual(0);
    });

    it("should initialize database schema correctly", async () => {
      const stub = getPrimaryDO("init-schema");

      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        // Check instance is properly created
        expect(instance).toBeInstanceOf(SearchIndexDO);

        // Check database version is set
        const dbVersion = await state.storage.get("db_version");
        expect(dbVersion).toBe(1);

        // Config may not be initialized yet - that's okay
        const config = await state.storage.get("config");
        expect(config).toBeUndefined(); // Config is only set when explicitly configured
      });
    });

    it("should accept configuration updates via RPC", async () => {
      const stub = getPrimaryDO("config-update");

      const config = {
        alarmIntervalMs: 30000,
        purgeThresholdDocs: 1000,
        replicas: [{ type: "local" as const, id: "replica-1" }],
      };

      // Use RPC method instead of HTTP since /configure was removed from DO
      await stub.configureRPC(config);

      // Verify configuration was stored correctly
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const storedConfig = await state.storage.get("config");
        expect(storedConfig).toEqual(
          expect.objectContaining({
            alarmIntervalMs: 30000,
            purgeThresholdDocs: 1000,
          })
        );

        // Check alarm was set
        const alarmTime = await state.storage.getAlarm();
        expect(alarmTime).not.toBeNull();
      });
    });
  });

  describe("Document Indexing via RPC", () => {
    it("should index valid documents using RPC", async () => {
      const stub = getPrimaryDO("index-valid");

      const docs: Document[] = [
        { id: "doc1", content: "This is test content for document 1" },
        { id: "doc2", content: "This is test content for document 2" },
        { id: "doc3", content: "This is test content for document 3" },
      ];

      // Use RPC method
      const result = await stub.indexDocuments(docs);
      expect(result.success).toBe(true);
      expect(result.indexed).toBe(3);

      // Verify documents were actually stored in SQLite
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const count = countResult.toArray()[0]?.count || 0;
        expect(count).toBe(3);

        // Verify specific documents exist
        const docsResult = state.storage.sql.exec<{ id: string; content: string }>("SELECT id, content FROM documents");
        const storedDocs = docsResult.toArray();
        expect(storedDocs).toHaveLength(3);
        expect(storedDocs.some((d) => d.id === "doc1")).toBe(true);
        expect(storedDocs.some((d) => d.id === "doc2")).toBe(true);
        expect(storedDocs.some((d) => d.id === "doc3")).toBe(true);
      });
    });

    it("should handle upserts via RPC", async () => {
      const stub = getPrimaryDO("upsert-test");

      // Index a document
      const originalDoc: Document[] = [{ id: "upsert-test", content: "Original content" }];
      const result1 = await stub.indexDocuments(originalDoc);
      expect(result1.success).toBe(true);
      expect(result1.indexed).toBe(1);

      // Wait a bit to ensure the first operation completes
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Update the same document
      const updatedDoc: Document[] = [{ id: "upsert-test", content: "Updated content" }];
      const result2 = await stub.indexDocuments(updatedDoc);
      expect(result2.success).toBe(true);
      expect(result2.indexed).toBe(1);

      // Wait a bit to ensure the second operation completes
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify content was updated, not duplicated
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const contentResult = state.storage.sql.exec<{ id: string; content: string }>(
          "SELECT id, content FROM documents"
        );
        const docs = contentResult.toArray();

        // Filter to only our test document
        const testDocs = docs.filter((d) => d.id === "upsert-test");
        expect(testDocs).toHaveLength(1); // Should be only one document with this ID
        // Content preprocessing: "Updated content" → "updated" (after filtering "content" as common term)
        expect(testDocs[0]!.content).toBe("updated");
      });
    });

    it("should reject invalid documents via RPC", async () => {
      const stub = getPrimaryDO("invalid-docs");

      const invalidDocs: TestDocument[] = [
        { id: "valid", content: "Valid content" },
        { id: "123", content: "Invalid string that looks like number" }, // Use string instead of number
        { content: "Missing id" } as TestDocument, // Type assertion for test data
      ];

      const result = await stub.indexDocuments(invalidDocs as Document[]);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid documents");
      expect(result.details).toBeDefined();

      // Verify NO documents were stored (validation happens before any indexing)
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const count = countResult.toArray()[0]?.count || 0;
        expect(count).toBe(0); // NO documents should be stored when validation fails
      });
    });
  });

  describe("Search Functionality via RPC and HTTP", () => {
    it("should perform basic search using RPC after indexing", async () => {
      const stub = getPrimaryDO("basic-search");

      // First index some documents via RPC - use simple, distinct terms
      const docs: Document[] = [
        { id: "search-1", content: "TypeScript programming tutorial" },
        { id: "search-2", content: "Python development guide" },
      ];

      const indexResult = await stub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(2);

      // Wait for indexing to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Now search using RPC - search for "TypeScript"
      const results = await stub.searchDocuments({ query: "TypeScript", maxResults: 100 });
      expect(Array.isArray(results)).toBe(true);

      // Should find at least one document
      expect(results.length).toBeGreaterThanOrEqual(1);

      // Verify search results have expected structure
      if (results.length > 0) {
        const result = results[0]!;
        expect(result.id).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.rank).toBeDefined();
        expect(typeof result.rank).toBe("number");
      }
    });

    it("should handle search via HTTP endpoint for external API", async () => {
      const stub = getPrimaryDO("sql-search");

      // Index documents with specific content for testing
      const docs: Document[] = [
        { id: "sql-1", content: "React framework building interfaces" },
        { id: "sql-2", content: "Vue framework creating apps" },
      ];

      const indexResult = await stub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(2);

      // Wait for indexing to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Test search through HTTP endpoint (external API)
      const response = await stub.fetch("http://do/search?q=framework");
      expect(response.status).toBe(200);
      const results = (await response.json()) as SearchResult[];

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should return empty results for non-matching queries", async () => {
      const stub = getPrimaryDO("empty-search");

      // Test HTTP endpoint
      const response = await stub.fetch("http://do/search?q=nonexistentterm12345");
      expect(response.status).toBe(200);
      const httpResults = (await response.json()) as SearchResult[];
      expect(Array.isArray(httpResults)).toBe(true);
      expect(httpResults).toHaveLength(0);
    });
  });

  describe("Stats via HTTP and RPC", () => {
    it("should return accurate document statistics", async () => {
      const stub = getPrimaryDO("stats-test");

      // Index some documents first
      const docs: Document[] = [
        { id: "stats-1", content: "Content for stats test" },
        { id: "stats-2", content: "More content for testing" },
      ];

      const indexResult = await stub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(2);

      // Wait for indexing to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Test HTTP endpoint
      const response = await stub.fetch("http://do/stats");
      expect(response.status).toBe(200);
      const httpStats = (await response.json()) as DOStats;
      expect(httpStats.count).toBeGreaterThanOrEqual(2);
      expect(httpStats.estimatedSize).toBeGreaterThan(0);

      // Test RPC method
      const rpcStats = await stub.getStats();
      expect(rpcStats.count).toBeGreaterThanOrEqual(2);
      expect(rpcStats.estimatedSize).toBeGreaterThan(0);
      expect(rpcStats.count).toBe(httpStats.count);
      expect(rpcStats.estimatedSize).toBe(httpStats.estimatedSize);
    });

    it("should track read-only status correctly", async () => {
      const stub = getPrimaryDO("readonly-test");

      // Configure as read-only via RPC
      await stub.configureRPC({ isReadOnly: true });

      const response = await stub.fetch("http://do/stats");
      expect(response.status).toBe(200);
      const httpStats = (await response.json()) as DOStats;
      expect(httpStats.isReadOnly).toBe(true);

      // Also test via RPC
      const rpcStats = await stub.getStats();
      expect(rpcStats.isReadOnly).toBe(true);
    });
  });

  describe("Storage Isolation", () => {
    it("should create fresh DO instances for each test", async () => {
      // With isolatedStorage: false, DOs from previous tests persist
      // But each test gets a unique DO name, so they're effectively isolated
      const initialIds = await listDurableObjectIds(env.PRIMARY_INDEX_DO);

      // Create a DO and add some data
      const stub = getPrimaryDO("isolation-test");

      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        // Verify it's a fresh instance
        const dbVersion = await state.storage.get("db_version");
        expect(dbVersion).toBe(1);

        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const count = countResult.toArray()[0]?.count || 0;
        expect(count).toBe(0); // Should start empty
      });

      // Verify we created a new DO instance
      const finalIds = await listDurableObjectIds(env.PRIMARY_INDEX_DO);
      expect(finalIds.length).toBeGreaterThan(initialIds.length);
    });
  });

  describe("Integer ID Optimization with RPC", () => {
    it("should use REPLACE optimization for integer IDs", async () => {
      // Create a new DO to test integer ID schema
      const integerIdStub = env.PRIMARY_INDEX_DO.get(
        env.PRIMARY_INDEX_DO.idFromName(`integer-test-${Date.now()}`)
      ) as DurableObjectStub<SearchIndexDO>;

      // Configure it for integer IDs first using RPC
      await integerIdStub.configureRPC({ idType: "integer" });

      // Wait for configuration to complete
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Index documents with integer IDs via RPC
      const docs: TestDocument[] = [{ id: 1, content: "First document with integer ID" }];

      const indexResult = await integerIdStub.indexDocuments(docs as Document[]);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(1);

      // Wait for indexing to complete
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify document count using RPC
      const stats = await integerIdStub.getStats();
      expect(stats.count).toBe(1);
    });
  });
});
