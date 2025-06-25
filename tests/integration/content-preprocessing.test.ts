import { SearchIndexDO } from "@/durables";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Content Preprocessing Integration", () => {
  const getPrimaryDO = () => {
    const id = env.PRIMARY_INDEX_DO.idFromName("preprocessing-test");
    return env.PRIMARY_INDEX_DO.get(id) as DurableObjectStub<SearchIndexDO>;
  };

  describe("Index-Time Content Preprocessing", () => {
    it("should preprocess content when indexing documents", async () => {
      const stub = getPrimaryDO();

      // Document with lots of stop words and common terms
      const docs = [
        {
          id: "doc1",
          content: "The cat is on the mat and the meme is funny",
        },
        {
          id: "doc2",
          content: "JavaScript programming tutorial about React hooks",
        },
      ];

      // Use RPC method instead of HTTP
      const indexResult = await stub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(2);

      // Verify the content was preprocessed in storage
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const result = state.storage.sql.exec<{ id: string; content: string }>(
          "SELECT id, content FROM documents ORDER BY id"
        );
        const storedDocs = result.toArray();

        expect(storedDocs).toHaveLength(2);

        // Doc1: "The cat is on the mat and the meme is funny" -> "mat" (all others are stop/common words)
        expect(storedDocs[0]?.id).toBe("doc1");
        expect(storedDocs[0]?.content).toBe("mat");

        // Doc2: "JavaScript programming tutorial about React hooks" -> "javascript programming tutorial react hooks"
        expect(storedDocs[1]?.id).toBe("doc2");
        expect(storedDocs[1]?.content).toBe("javascript programming tutorial react hooks");
      });
    });

    it("should handle documents that become empty after preprocessing", async () => {
      const stub = getPrimaryDO();

      // Clear any existing data first
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        state.storage.sql.exec("DELETE FROM documents");
      });

      const docs = [
        {
          id: "empty1",
          content: "The cat meme is funny and trending", // All stop/common words
        },
        {
          id: "normal1",
          content: "Python Django framework development",
        },
      ];

      // Use RPC method
      const indexResult = await stub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(2);

      // Both documents should be indexed, even if content becomes empty
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const result = state.storage.sql.exec<{ id: string; content: string }>(
          "SELECT id, content FROM documents WHERE id IN ('empty1', 'normal1') ORDER BY id"
        );
        const storedDocs = result.toArray();

        expect(storedDocs).toHaveLength(2);

        // empty1 should have empty content after preprocessing
        expect(storedDocs[0]?.id).toBe("empty1");
        expect(storedDocs[0]?.content).toBe("");

        // normal1 should have preprocessed content
        expect(storedDocs[1]?.id).toBe("normal1");
        expect(storedDocs[1]?.content).toBe("python django framework development");
      });
    });

    it("should improve search results by filtering common terms", async () => {
      const stub = getPrimaryDO();

      // Clear any existing data first
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        state.storage.sql.exec("DELETE FROM documents");
      });

      // Index documents with overlapping common and specific terms
      const docs = [
        {
          id: "generic1",
          content: "This is a funny cat meme video that is trending",
        },
        {
          id: "specific1",
          content: "TypeScript compiler optimization techniques",
        },
        {
          id: "mixed1",
          content: "JavaScript tutorial about funny meme generator",
        },
      ];

      // Use RPC method
      const indexResult = await stub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(3);

      // Search for "JavaScript" should only find relevant document
      const searchResponse = await stub.fetch("http://do/search?q=javascript");
      expect(searchResponse.status).toBe(200);
      const results = (await searchResponse.json()) as any[];

      // Filter to only our test documents
      const testResults = results.filter((r) => ["generic1", "specific1", "mixed1"].includes(r.id));
      expect(testResults).toHaveLength(1);
      expect(testResults[0]?.id).toBe("mixed1");

      // Search for "cat" won't find anything (common term removed)
      const catSearchResponse = await stub.fetch("http://do/search?q=cat");
      expect(catSearchResponse.status).toBe(200);
      const catResults = (await catSearchResponse.json()) as any[];

      // Filter to only our test documents (should be empty since "cat" is removed)
      const testCatResults = catResults.filter((r) => ["generic1", "specific1", "mixed1"].includes(r.id));
      expect(testCatResults).toHaveLength(0);

      // Search for "optimization" should find specific document
      const optSearchResponse = await stub.fetch("http://do/search?q=optimization");
      expect(optSearchResponse.status).toBe(200);
      const optResults = (await optSearchResponse.json()) as any[];

      // Filter to only our test documents
      const testOptResults = optResults.filter((r) => ["generic1", "specific1", "mixed1"].includes(r.id));
      expect(testOptResults).toHaveLength(1);
      expect(testOptResults[0]?.id).toBe("specific1");
    });

    it("should handle upserts with content preprocessing", async () => {
      const stub = getPrimaryDO();

      // Initial document
      const initialDoc = {
        id: "upsert1",
        content: "The original cat meme is very funny",
      };

      // Use RPC method
      const indexResult1 = await stub.indexDocuments([initialDoc]);
      expect(indexResult1.success).toBe(true);
      expect(indexResult1.indexed).toBe(1);

      // Verify initial content
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const result = state.storage.sql.exec<{ content: string }>(
          "SELECT content FROM documents WHERE id = 'upsert1'"
        );
        const doc = result.toArray()[0];
        expect(doc?.content).toBe("original"); // Only "original" survives preprocessing
      });

      // Update document
      const updatedDoc = {
        id: "upsert1",
        content: "The updated JavaScript React tutorial is amazing",
      };

      // Use RPC method
      const indexResult2 = await stub.indexDocuments([updatedDoc]);
      expect(indexResult2.success).toBe(true);
      expect(indexResult2.indexed).toBe(1);

      // Verify updated content
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const result = state.storage.sql.exec<{ content: string }>(
          "SELECT content FROM documents WHERE id = 'upsert1'"
        );
        const doc = result.toArray()[0];
        expect(doc?.content).toBe("updated javascript react tutorial"); // Preprocessed content
      });
    });

    it("should significantly reduce index size", async () => {
      const stub = getPrimaryDO();

      // Documents with lots of common content
      const docs = Array.from({ length: 50 }, (_, i) => ({
        id: `size-test-${i}`,
        content: `This is a funny cat meme video number ${i} that is trending and viral on the internet today`,
      }));

      // Use RPC method
      const indexResult = await stub.indexDocuments(docs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(50);

      // Check that content is significantly reduced
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        const result = state.storage.sql.exec<{ content: string }>(
          "SELECT content FROM documents WHERE id = 'size-test-0'"
        );
        const doc = result.toArray()[0];

        // Original: ~90 chars, preprocessed: "number internet" (~16 chars)
        // Note: "0" is filtered out because it's only 1 character (< 2 char minimum)
        expect(doc?.content).toBe("number internet");

        // Calculate size reduction
        const originalLength =
          "This is a funny cat meme video number 0 that is trending and viral on the internet today".length;
        const processedLength = doc?.content?.length ?? 0;
        const reduction = ((originalLength - processedLength) / originalLength) * 100;

        // Should achieve at least 70% size reduction
        expect(reduction).toBeGreaterThan(70);
      });
    });
  });
});
