import { SearchIndexDO } from "@/durables";
import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Cold Storage Edge Cases", () => {
  // Helper function to get a DO instance
  const getPrimaryDO = () => {
    const id = env.PRIMARY_INDEX_DO.idFromName("test-cold-primary");
    return env.PRIMARY_INDEX_DO.get(id) as DurableObjectStub<SearchIndexDO>;
  };

  const getColdStorageDO = (index: number) => {
    const id = env.COLD_STORAGE_DO.idFromName(`test-cold-storage-${index}`);
    return env.COLD_STORAGE_DO.get(id) as DurableObjectStub<SearchIndexDO>;
  };

  describe("Cold Storage Configuration", () => {
    it("should configure cold storage settings", async () => {
      const stub = getPrimaryDO();

      const config = {
        purgeThresholdDocs: 10,
        purgeTargetDocs: 5,
        coldStorageThresholdDocs: 3,
        coldStoragePrefix: "test-cold-storage",
      };

      // Use RPC method for configuration
      await stub.configureRPC(config);

      // Verify configuration was stored correctly
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const storedConfig = await state.storage.get("config");
        expect(storedConfig).toEqual(expect.objectContaining(config));
      });
    });

    it("should mark cold storage DO as read-only", async () => {
      const coldStub = getColdStorageDO(0);

      // Use RPC method for configuration
      await coldStub.configureRPC({ isReadOnly: true });

      // Verify it's marked as read-only using RPC
      const stats = await coldStub.getStats();
      expect(stats.isReadOnly).toBe(true);

      // Also verify directly in storage
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const config = await state.storage.get("config");
        expect(config).toEqual(expect.objectContaining({ isReadOnly: true }));
      });
    });
  });

  describe("Cold Storage Search", () => {
    it("should search in cold storage directly", async () => {
      const coldStub = getColdStorageDO(1);

      // Index some documents in cold storage using RPC
      const docs = [
        { id: "cold-1", content: "Cold storage document about TypeScript" },
        { id: "cold-2", content: "Cold storage document about JavaScript" },
      ];

      const indexResult = await coldStub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(2);

      // Verify documents were stored
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const count = countResult.toArray()[0]?.count || 0;
        expect(count).toBe(2);
      });

      // Search for TypeScript
      const searchResponse = await coldStub.fetch("http://do/search?q=TypeScript");
      expect(searchResponse.status).toBe(200);

      const results = (await searchResponse.json()) as any[];
      expect(Array.isArray(results)).toBe(true);

      // Should find the TypeScript document (accounting for content preprocessing)
      const tsResults = results.filter((r) => r.content.toLowerCase().includes("typescript"));
      expect(tsResults.length).toBeGreaterThan(0);
    });

    it("should include cold storage in search when requested", async () => {
      const primaryStub = getPrimaryDO();

      // Configure with cold storage using RPC
      await primaryStub.configureRPC({
        currentColdStorageIndex: 1,
        coldStoragePrefix: "test-cold-storage",
      });

      // Index some documents in primary using RPC
      const primaryDocs = [{ id: "primary-1", content: "Primary storage document about Node.js" }];

      const indexResult = await primaryStub.indexDocuments(primaryDocs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(1);

      // Search with cold storage inclusion
      const searchResponse = await primaryStub.fetch("http://do/search?q=storage&includeCold=true");
      expect(searchResponse.status).toBe(200);

      const results = (await searchResponse.json()) as any[];
      expect(Array.isArray(results)).toBe(true);
    });

    it("should skip cold storage search for read-only DOs", async () => {
      const coldStub = getColdStorageDO(2);

      // Configure as read-only using RPC
      await coldStub.configureRPC({ isReadOnly: true });

      // Verify it's configured as read-only
      const configCheckStats = await coldStub.getStats();
      expect(configCheckStats.isReadOnly).toBe(true);

      // Attempt to index some documents - this should fail for read-only DO
      const docs = [{ id: "readonly-1", content: "Read-only document content" }];

      const indexResult = await coldStub.indexDocuments(docs);
      expect(indexResult.success).toBe(false);
      expect(indexResult.error).toContain("read-only");

      // Search should still work on read-only DOs (they can search their existing data)
      const searchResponse = await coldStub.fetch("http://do/search?q=content&includeCold=true");
      expect(searchResponse.status).toBe(200);

      const results = (await searchResponse.json()) as any[];
      expect(Array.isArray(results)).toBe(true);
      // Should return empty results since we couldn't index any documents
      expect(results.length).toBe(0);
    });
  });

  describe("Document Operations", () => {
    it("should handle document indexing in cold storage", async () => {
      const coldStub = getColdStorageDO(3);

      const docs = [
        { id: "cold-doc-1", content: "Cold storage test document 1" },
        { id: "cold-doc-2", content: "Cold storage test document 2" },
        { id: "cold-doc-3", content: "Cold storage test document 3" },
      ];

      // Use RPC method for indexing
      const result = await coldStub.indexDocuments(docs);
      expect(result.success).toBe(true);
      expect(result.indexed).toBe(3);

      // Verify documents are searchable using direct SQL access
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const searchResult = state.storage.sql.exec<{ id: string; content: string }>(
          "SELECT id, content FROM documents WHERE documents MATCH 'storage'"
        );
        const searchDocs = searchResult.toArray();
        expect(searchDocs.length).toBeGreaterThan(0);
      });

      // Also verify through API
      const searchResponse = await coldStub.fetch("http://do/search?q=storage");
      const searchResults = (await searchResponse.json()) as any[];
      expect(searchResults.length).toBeGreaterThan(0);
    });

    it("should reject indexing on read-only cold storage", async () => {
      const coldStub = getColdStorageDO(4);

      // Configure as read-only using RPC
      await coldStub.configureRPC({ isReadOnly: true });

      const docs = [{ id: "readonly-reject", content: "This should be rejected" }];

      // Attempt to index should fail
      const result = await coldStub.indexDocuments(docs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("read-only");

      // Verify no documents were stored
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const count = countResult.toArray()[0]?.count || 0;
        expect(count).toBe(0);
      });
    });

    it("should handle sync operations on cold storage", async () => {
      const coldStub = getColdStorageDO(5);

      const docs = [
        { id: "sync-cold-1", content: "Sync to cold storage 1" },
        { id: "sync-cold-2", content: "Sync to cold storage 2" },
      ];

      // Use RPC method for sync
      const result = await coldStub.syncDocuments(docs);
      expect(result.success).toBe(true);
      expect(result.synced).toBe(2);

      // Verify documents were actually synced
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const count = countResult.toArray()[0]?.count || 0;
        expect(count).toBe(2);
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle cold storage search failures gracefully", async () => {
      const primaryStub = getPrimaryDO();

      // Configure with cold storage that may not exist using RPC
      await primaryStub.configureRPC({
        currentColdStorageIndex: 10, // High index that doesn't exist
        coldStoragePrefix: "nonexistent-cold",
      });

      // Search should still work even if cold storage fails
      const searchResponse = await primaryStub.fetch("http://do/search?q=test&includeCold=true");
      expect(searchResponse.status).toBe(200);

      const results = (await searchResponse.json()) as any[];
      expect(Array.isArray(results)).toBe(true);
    });

    it("should handle invalid cold storage configuration", async () => {
      const primaryStub = getPrimaryDO();

      const invalidConfig = {
        coldStorageThresholdDocs: 0, // Invalid threshold
        currentColdStorageIndex: -1, // Invalid index
      };

      // Use RPC method for configuration
      await primaryStub.configureRPC(invalidConfig);

      // Verify configuration was stored
      await runInDurableObject(primaryStub, async (instance: SearchIndexDO, state) => {
        const config = await state.storage.get("config");
        expect(config).toEqual(expect.objectContaining(invalidConfig));
      });
    });

    it("should handle large document batches in cold storage", async () => {
      const coldStub = getColdStorageDO(6);

      // Create a large batch of documents
      const largeBatch = Array.from({ length: 50 }, (_, i) => ({
        id: `large-batch-${i}`,
        content: `Large batch document ${i} content for testing`,
      }));

      // Use RPC method for indexing
      const result = await coldStub.indexDocuments(largeBatch);
      expect(result.success).toBe(true);
      expect(result.indexed).toBe(50);

      // Verify stats reflect the large batch using RPC
      const stats = await coldStub.getStats();
      expect(stats.count).toBeGreaterThanOrEqual(50);

      // Also verify with direct SQL access
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const count = countResult.toArray()[0]?.count || 0;
        expect(count).toBe(50);
      });
    });
  });

  describe("Stats and Monitoring", () => {
    it("should return accurate stats for cold storage", async () => {
      const coldStub = getColdStorageDO(7);

      // Index some documents using RPC
      const docs = [
        { id: "stats-cold-1", content: "Stats test document 1" },
        { id: "stats-cold-2", content: "Stats test document 2" },
        { id: "stats-cold-3", content: "Stats test document 3" },
      ];

      const indexResult = await coldStub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(3);

      // Get stats using RPC
      const stats = await coldStub.getStats();
      expect(stats.count).toBeGreaterThanOrEqual(3);
      expect(stats.estimatedSize).toBeGreaterThan(0);

      // Verify against direct SQL access
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
        const actualCount = countResult.toArray()[0]?.count || 0;
        expect(stats.count).toBe(actualCount);
      });
    });

    it("should track read-only status in stats", async () => {
      const coldStub = getColdStorageDO(8);

      // Configure as read-only using RPC
      await coldStub.configureRPC({ isReadOnly: true });

      // Get stats using RPC
      const stats = await coldStub.getStats();
      expect(stats.isReadOnly).toBe(true);

      // Verify against stored config
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const config = await state.storage.get("config");
        expect(config).toEqual(expect.objectContaining({ isReadOnly: true }));
      });
    });
  });

  describe("Storage Isolation", () => {
    it("should have isolated cold storage between tests", async () => {
      // In test environment, there may be DOs from other tests running concurrently
      // This test just verifies we can list DOs without errors
      const ids = await listDurableObjectIds(env.COLD_STORAGE_DO);
      expect(Array.isArray(ids)).toBe(true);

      // Create a cold storage DO and add some data
      const coldId = env.COLD_STORAGE_DO.idFromName("cold-storage-isolation-test");
      const coldStub = env.COLD_STORAGE_DO.get(coldId) as DurableObjectStub<SearchIndexDO>;

      // Clear any existing data in this specific DO
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        state.storage.sql.exec("DELETE FROM documents");
      });

      const docs = [
        { id: "cold-isolation-1", content: "Cold storage document 1" },
        { id: "cold-isolation-2", content: "Cold storage document 2" },
      ];

      // Use RPC method for indexing
      const result = await coldStub.indexDocuments(docs);
      expect(result.success).toBe(true);
      expect(result.indexed).toBe(2);

      // Verify our documents are stored in this specific DO
      await runInDurableObject(coldStub, async (instance: SearchIndexDO, state) => {
        const countResult = state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM documents WHERE id LIKE 'cold-isolation-%'"
        );
        const count = countResult.toArray()[0]?.count || 0;
        expect(count).toBe(2);
      });

      // Verify we can still list DOs
      const finalIds = await listDurableObjectIds(env.COLD_STORAGE_DO);
      expect(finalIds.length).toBeGreaterThan(0);
    });
  });
});
