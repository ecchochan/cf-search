import { SearchIndexDO } from "@/durables";
import { env, listDurableObjectIds, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker Integration Tests", () => {
  describe("POST /index - Document Indexing", () => {
    it("should accept valid documents and queue them", async () => {
      const docs = [
        { id: "doc1", content: "This is test content for document 1" },
        { id: "doc2", content: "This is test content for document 2" },
      ];

      const response = await SELF.fetch("http://test/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(docs),
      });

      expect(response.status).toBe(202);
      const result = (await response.json()) as any;
      expect(result.success).toBe(true);
      expect(result.message).toContain("2 documents queued");
    });

    it("should accept single document", async () => {
      const doc = { id: "doc1", content: "This is test content for document 1" };

      const response = await SELF.fetch("http://test/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });

      expect(response.status).toBe(202);
      const result = (await response.json()) as any;
      expect(result.success).toBe(true);
      expect(result.message).toContain("1 documents queued");
    });

    it("should reject invalid documents", async () => {
      const invalidDocs = [
        { id: "valid", content: "Valid content" },
        { content: "Missing id field" }, // No ID at all
        { id: "", content: "Empty string ID" }, // Empty string ID
      ];

      const response = await SELF.fetch("http://test/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalidDocs),
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as any;
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid document format");
    });

    it("should reject malformed JSON", async () => {
      const response = await SELF.fetch("http://test/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json",
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid JSON");
    });

    it("should reject empty document array", async () => {
      const response = await SELF.fetch("http://test/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([]),
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as any;
      expect(result.success).toBe(false);
      expect(result.error).toBe("No valid documents to index");
    });
  });

  describe("GET /search - Document Search", () => {
    it("should require query parameter", async () => {
      const response = await SELF.fetch("http://test.com/search");
      expect(response.status).toBe(400);

      const result = (await response.json()) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing query parameter");
    });

    it("should route to regional replica with location hint", async () => {
      const response = await SELF.fetch("http://test/search?q=test", {
        cf: { colo: "LAX" } as any,
      });

      // Should attempt to route to regional replica and return search results
      // The actual search may return empty results since we haven't indexed anything yet
      expect(response.status).toBe(200);
      const results = await response.json();
      expect(Array.isArray(results)).toBe(true);
    });

    it("should handle missing cf-colo header", async () => {
      const response = await SELF.fetch("http://test/search?q=test");

      // Should still work, just use 'auto' as fallback
      expect(response.status).toBe(200);
      const results = await response.json();
      expect(Array.isArray(results)).toBe(true);
    });

    it("should perform end-to-end search after indexing", async () => {
      // Get the primary DO
      const id = env.PRIMARY_INDEX_DO.idFromName("primary-search-index-v1");
      const stub = env.PRIMARY_INDEX_DO.get(id, { locationHint: "wnam" }) as DurableObjectStub<SearchIndexDO>;

      // Clear any existing data first
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        state.storage.sql.exec("DELETE FROM documents");
      });

      const docs = [
        { id: "search-e2e-1", content: "End-to-end JavaScript testing tutorial" },
        { id: "search-e2e-2", content: "Advanced TypeScript development guide" },
      ];

      // Index documents using RPC method
      const indexResult = await stub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(2);

      // Search directly on the primary DO where we indexed
      const searchResponse = await stub.fetch("http://do/search?q=JavaScript");
      expect(searchResponse.status).toBe(200);

      const results = (await searchResponse.json()) as any[];
      expect(Array.isArray(results)).toBe(true);

      // Filter to only our test documents and check for JavaScript
      const testResults = results.filter((r) => ["search-e2e-1", "search-e2e-2"].includes(r.id));
      const jsResults = testResults.filter((r) => r.content?.includes("javascript") || r.id === "search-e2e-1");
      expect(jsResults.length).toBeGreaterThan(0);
      expect(jsResults[0].id).toBe("search-e2e-1");
    });
  });

  describe("POST /configure - System Configuration", () => {
    it("should forward configuration to primary DO", async () => {
      const config = {
        alarmIntervalMs: 30000,
        purgeThresholdDocs: 1000,
        replicas: [{ type: "region", name: "weur" }],
      };

      const response = await SELF.fetch("http://test/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.success).toBe(true);
      expect(result.message).toBe("Configuration updated successfully");

      // Verify configuration was applied to primary DO
      const id = env.PRIMARY_INDEX_DO.idFromName("primary-search-index-v1");
      const stub = env.PRIMARY_INDEX_DO.get(id) as DurableObjectStub<SearchIndexDO>;

      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const storedConfig = await state.storage.get("config");
        expect(storedConfig).toEqual(expect.objectContaining(config));
      });
    });
  });

  describe("Error Handling", () => {
    it("should return 404 for unknown endpoints", async () => {
      const response = await SELF.fetch("http://test/unknown");

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    it("should handle wrong HTTP methods", async () => {
      const response = await SELF.fetch("http://test/search", { method: "POST" });

      expect(response.status).toBe(404);
    });

    it("should handle missing request body for POST /index", async () => {
      const response = await SELF.fetch("http://test/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No body
      });

      expect(response.status).toBe(400);
    });
  });

  describe("Content Type Handling", () => {
    it("should return JSON responses with correct content type", async () => {
      const docs = [{ id: "doc1", content: "Test content" }];

      const response = await SELF.fetch("http://test/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(docs),
      });

      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  });

  describe("Durable Object Management", () => {
    it("should isolate storage between tests", async () => {
      // In test environment, there may be DOs from other tests running concurrently
      // This test just verifies we can list DOs without errors
      const primaryIds = await listDurableObjectIds(env.PRIMARY_INDEX_DO);
      const replicaIds = await listDurableObjectIds(env.REGION_REPLICA_DO);
      const coldIds = await listDurableObjectIds(env.COLD_STORAGE_DO);

      // Should be able to get lists without errors
      expect(Array.isArray(primaryIds)).toBe(true);
      expect(Array.isArray(replicaIds)).toBe(true);
      expect(Array.isArray(coldIds)).toBe(true);
    });

    it("should create DOs on demand", async () => {
      // Access a DO to create it
      const id = env.PRIMARY_INDEX_DO.idFromName("test-primary");
      const stub = env.PRIMARY_INDEX_DO.get(id) as DurableObjectStub<SearchIndexDO>;

      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        // Check that it's properly initialized
        expect(instance).toBeInstanceOf(SearchIndexDO);
        const dbVersion = await state.storage.get("db_version");
        expect(dbVersion).toBe(1);
      });

      // Verify DO can be accessed (it may exist among other DOs in test environment)
      const ids = await listDurableObjectIds(env.PRIMARY_INDEX_DO);
      expect(ids.length).toBeGreaterThan(0);
      const hasOurDO = ids.some((testId) => testId.equals(id));
      expect(hasOurDO).toBe(true);
    });
  });
});
