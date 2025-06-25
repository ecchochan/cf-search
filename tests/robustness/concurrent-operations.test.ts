import { SearchIndexDO } from "@/durables";
import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Concurrent Operations & Race Conditions", () => {
  const getPrimaryDO = () => {
    const id = env.PRIMARY_INDEX_DO.idFromName("concurrent-test-primary");
    return env.PRIMARY_INDEX_DO.get(id) as DurableObjectStub<SearchIndexDO>;
  };

  describe("Concurrent Indexing", () => {
    it("should handle concurrent document indexing without corruption", async () => {
      const stub = getPrimaryDO();

      // Create multiple batches of documents to index concurrently
      const batch1 = Array.from({ length: 20 }, (_, i) => ({
        id: `concurrent-batch1-${i}`,
        content: `Batch 1 document ${i} content`,
      }));

      const batch2 = Array.from({ length: 20 }, (_, i) => ({
        id: `concurrent-batch2-${i}`,
        content: `Batch 2 document ${i} content`,
      }));

      const batch3 = Array.from({ length: 20 }, (_, i) => ({
        id: `concurrent-batch3-${i}`,
        content: `Batch 3 document ${i} content`,
      }));

      // Index all batches concurrently using RPC
      const [result1, result2, result3] = await Promise.all([
        stub.indexDocuments(batch1),
        stub.indexDocuments(batch2),
        stub.indexDocuments(batch3),
      ]);

      // All operations should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);

      expect(result1.indexed).toBe(20);
      expect(result2.indexed).toBe(20);
      expect(result3.indexed).toBe(20);

      // Verify all documents are present and searchable
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const totalCount = countResult.toArray()[0]?.count || 0;
        expect(totalCount).toBe(60);

        // Test searches for each batch using processed content terms
        const batch1Results = state.storage.sql.exec<{ id: string }>(
          "SELECT id FROM documents WHERE id LIKE 'concurrent-batch1-%'"
        );
        expect(batch1Results.toArray().length).toBe(20);

        const batch2Results = state.storage.sql.exec<{ id: string }>(
          "SELECT id FROM documents WHERE id LIKE 'concurrent-batch2-%'"
        );
        expect(batch2Results.toArray().length).toBe(20);
      });
    });

    it("should handle concurrent upserts correctly", async () => {
      const stub = getPrimaryDO();

      const originalDoc = { id: "upsert-race-test", content: "Original content" };

      // Index original document using RPC
      const initialResult = await stub.indexDocuments([originalDoc]);
      expect(initialResult.success).toBe(true);
      expect(initialResult.indexed).toBe(1);

      // Perform concurrent upserts with different content using RPC
      const [result1, result2, result3] = await Promise.all([
        stub.indexDocuments([{ id: "upsert-race-test", content: "Updated by operation 1" }]),
        stub.indexDocuments([{ id: "upsert-race-test", content: "Updated by operation 2" }]),
        stub.indexDocuments([{ id: "upsert-race-test", content: "Updated by operation 3" }]),
      ]);

      // All operations should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);

      // Verify only one document exists with this ID
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const result = state.storage.sql.exec<{ id: string; content: string }>(
          "SELECT id, content FROM documents WHERE id = 'upsert-race-test'"
        );
        const docs = result.toArray();
        expect(docs).toHaveLength(1);
        // After preprocessing: "Updated by operation X" becomes "updated operation"
        // (numbers like "1", "2", "3" are filtered out since they're < 2 chars)
        expect(docs[0]?.content).toBe("updated operation");
      });
    });
  });

  describe("Concurrent Search Operations", () => {
    it("should handle concurrent searches without interference", async () => {
      const stub = getPrimaryDO();

      // Index some test documents using RPC
      const testDocs = [
        { id: "search-test-1", content: "TypeScript programming language tutorial" },
        { id: "search-test-2", content: "JavaScript development best practices" },
        { id: "search-test-3", content: "Node.js backend development guide" },
        { id: "search-test-4", content: "React frontend development patterns" },
      ];

      const indexResult = await stub.indexDocuments(testDocs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(4);

      // Perform concurrent searches
      const [response1, response2, response3, response4] = await Promise.all([
        stub.fetch("http://do/search?q=TypeScript"),
        stub.fetch("http://do/search?q=JavaScript"),
        stub.fetch("http://do/search?q=development"),
        stub.fetch("http://do/search?q=programming"),
      ]);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(response3.status).toBe(200);
      expect(response4.status).toBe(200);

      const results1 = (await response1.json()) as any[];
      const results2 = (await response2.json()) as any[];
      const results3 = (await response3.json()) as any[];
      const results4 = (await response4.json()) as any[];

      // Verify search results are accurate (content is preprocessed)
      expect(results1.some((r) => r.content.toLowerCase().includes("typescript"))).toBe(true);
      expect(results2.some((r) => r.content.toLowerCase().includes("javascript"))).toBe(true);
      expect(results3.length).toBeGreaterThan(0); // "development" appears in multiple docs
      expect(results4.some((r) => r.content.toLowerCase().includes("programming"))).toBe(true);
    });
  });

  describe("Mixed Concurrent Operations", () => {
    it("should handle concurrent indexing and searching", async () => {
      const stub = getPrimaryDO();

      // Clear any existing data first
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        state.storage.sql.exec("DELETE FROM documents");
      });

      // Index initial documents using RPC
      const initialDocs = [
        { id: "concurrent-1", content: "TypeScript development tutorial" },
        { id: "concurrent-2", content: "React hooks programming guide" },
      ];

      const indexResult = await stub.indexDocuments(initialDocs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(2);

      // Perform concurrent operations
      const newDocs = [
        { id: "concurrent-3", content: "Vue.js development patterns" },
        { id: "concurrent-4", content: "Angular component architecture" },
      ];

      const promises = [
        // Concurrent indexing using RPC
        stub.indexDocuments(newDocs),
        // Concurrent searching using HTTP
        stub.fetch("http://do/search?q=TypeScript"),
        stub.fetch("http://do/search?q=React"),
      ];

      const results = await Promise.all(promises);

      // Type-safe handling of mixed results
      const concurrentIndexResult = results[0] as Awaited<ReturnType<typeof stub.indexDocuments>>;
      const searchResponse1 = results[1] as Response;
      const searchResponse2 = results[2] as Response;

      expect(concurrentIndexResult.success).toBe(true);
      expect(searchResponse1.status).toBe(200);
      expect(searchResponse2.status).toBe(200);

      const searchResults1 = (await searchResponse1.json()) as any[];
      const searchResults2 = (await searchResponse2.json()) as any[];

      expect(Array.isArray(searchResults1)).toBe(true);
      expect(Array.isArray(searchResults2)).toBe(true);

      // Verify all documents were indexed correctly
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM documents WHERE id LIKE 'concurrent-%'"
        );
        const totalCount = countResult.toArray()[0]?.count || 0;
        expect(totalCount).toBe(4); // 2 initial + 2 new
      });
    });
  });

  describe("Configuration Race Conditions", () => {
    it("should handle concurrent configuration updates", async () => {
      const stub = getPrimaryDO();

      // Perform concurrent configuration updates using RPC
      const [result1, result2, result3] = await Promise.all([
        stub.configureRPC({ alarmIntervalMs: 10000 }),
        stub.configureRPC({ purgeThresholdDocs: 5000 }),
        stub.configureRPC({ coldStorageThresholdDocs: 2000 }),
      ]);

      // All configuration updates should succeed (RPC doesn't return values but shouldn't throw)

      // Verify final configuration contains all updates
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const config = await state.storage.get("config");
        expect(config).toEqual(
          expect.objectContaining({
            alarmIntervalMs: 10000,
            purgeThresholdDocs: 5000,
            coldStorageThresholdDocs: 2000,
          })
        );
      });
    });
  });

  describe("Storage Isolation", () => {
    it("should have isolated storage for concurrent tests", async () => {
      // This test verifies we can safely list DOs without errors in test environment
      const ids = await listDurableObjectIds(env.PRIMARY_INDEX_DO);
      expect(Array.isArray(ids)).toBe(true);

      // Create multiple DOs concurrently
      const doPromises = Array.from({ length: 3 }, (_, i) => {
        const id = env.PRIMARY_INDEX_DO.idFromName(`concurrent-test-${i}`);
        const stub = env.PRIMARY_INDEX_DO.get(id) as DurableObjectStub<SearchIndexDO>;
        return runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
          // Just verify initialization
          expect(instance).toBeInstanceOf(SearchIndexDO);
          return id;
        });
      });

      const createdIds = await Promise.all(doPromises);
      expect(createdIds).toHaveLength(3);

      // Verify all were created
      const finalIds = await listDurableObjectIds(env.PRIMARY_INDEX_DO);
      expect(finalIds.length).toBeGreaterThan(0);
    });
  });
});
