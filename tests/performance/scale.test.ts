import { SearchIndexDO } from "@/durables";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Performance & Scale Testing", () => {
  const getPrimaryDO = () => {
    const id = env.PRIMARY_INDEX_DO.idFromName("performance-test");
    return env.PRIMARY_INDEX_DO.get(id) as DurableObjectStub<SearchIndexDO>;
  };

  describe("Large Scale Document Processing", () => {
    it("should handle 10K documents efficiently", async () => {
      const stub = getPrimaryDO();

      // Clear existing data
      await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
        state.storage.sql.exec("DELETE FROM documents");
      });

      // Create realistic documents with varying content sizes
      const docs = Array.from({ length: 10000 }, (_, i) => ({
        id: `doc-${i.toString().padStart(5, "0")}`,
        content: generateRealisticContent(i),
      }));

      const startTime = Date.now();

      // Index in batches to simulate real-world usage
      const batchSize = 100;
      const batches = [];
      for (let i = 0; i < docs.length; i += batchSize) {
        batches.push(docs.slice(i, i + batchSize));
      }

      let totalIndexed = 0;
      for (const batch of batches) {
        const result = await stub.indexDocuments(batch);
        expect(result.success).toBe(true);
        totalIndexed += result.indexed;
      }

      const indexTime = Date.now() - startTime;

      expect(totalIndexed).toBe(10000);
      expect(indexTime).toBeLessThan(60000); // Should complete within 60 seconds

      // Verify search performance
      const searchStart = Date.now();
      const searchResponse = await stub.fetch("http://do/search?q=javascript");
      const searchTime = Date.now() - searchStart;

      expect(searchResponse.status).toBe(200);
      expect(searchTime).toBeLessThan(1000); // Search should be under 1 second

      // Verify database size is reasonable
      const stats = await stub.getStats();
      expect(stats.count).toBe(10000);
      expect(stats.estimatedSize).toBeLessThan(100 * 1024 * 1024); // Under 100MB
    });

    it("should maintain search accuracy with diverse content", async () => {
      const stub = getPrimaryDO();

      const realWorldDocs = [
        {
          id: "tech-article-1",
          content: `
            # Building Modern Web Applications with React and TypeScript
            
            React has become the de facto standard for building user interfaces in modern web development.
            When combined with TypeScript, it provides a robust foundation for scalable applications.
            
            ## Key Benefits
            - Type safety reduces runtime errors
            - Better IDE support and autocompletion
            - Improved code maintainability
            
            This comprehensive guide covers best practices for React TypeScript development.
          `,
        },
        {
          id: "api-doc-1",
          content: `
            ## API Endpoint: GET /api/users/{id}
            
            Retrieves user information by ID.
            
            ### Parameters
            - id (required): User identifier
            
            ### Response
            \`\`\`json
            {
              "id": "12345",
              "name": "John Doe",
              "email": "john@example.com"
            }
            \`\`\`
            
            ### Error Codes
            - 404: User not found
            - 403: Insufficient permissions
          `,
        },
        {
          id: "blog-post-1",
          content: `
            The Future of AI in Software Development
            
            Artificial Intelligence is transforming how we write, test, and maintain code.
            From intelligent code completion to automated bug detection, AI tools are becoming
            indispensable for modern developers.
            
            Machine learning models can now:
            - Generate code from natural language descriptions
            - Automatically detect security vulnerabilities
            - Suggest performance optimizations
            - Write comprehensive test suites
            
            As we look toward the future, the integration of AI in development workflows
            will only deepen, making developers more productive and software more reliable.
          `,
        },
      ];

      const indexResult = await stub.indexDocuments(realWorldDocs);
      expect(indexResult.success).toBe(true);
      expect(indexResult.indexed).toBe(3);

      // Test various real-world search patterns
      const searchTests = [
        { query: "React TypeScript", expectedResults: ["tech-article-1"] },
        { query: "API endpoint GET", expectedResults: ["api-doc-1"] },
        { query: "artificial intelligence software", expectedResults: ["blog-post-1"] },
        { query: "code development", expectedResults: ["tech-article-1", "blog-post-1"] },
      ];

      for (const test of searchTests) {
        const response = await stub.fetch(`http://do/search?q=${encodeURIComponent(test.query)}`);
        expect(response.status).toBe(200);

        const results = (await response.json()) as any[];
        const resultIds = results.map((r) => r.id);

        // Check that expected results are found
        for (const expectedId of test.expectedResults) {
          expect(resultIds).toContain(expectedId);
        }
      }
    });
  });

  describe("Search Performance Under Load", () => {
    it("should handle concurrent search requests efficiently", async () => {
      const stub = getPrimaryDO();

      // Index test data
      const docs = Array.from({ length: 1000 }, (_, i) => ({
        id: `perf-doc-${i}`,
        content: `Performance test document ${i} containing searchable terms like javascript react typescript node development`,
      }));

      await stub.indexDocuments(docs);

      // Simulate concurrent search load
      const searchQueries = [
        "javascript",
        "react",
        "typescript",
        "node",
        "development",
        "performance",
        "test",
        "document",
        "searchable",
        "terms",
      ];

      const concurrentRequests = 50;
      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        const query = searchQueries[i % searchQueries.length];
        return stub.fetch(`http://do/search?q=${query}`);
      });

      const startTime = Date.now();
      const responses = await Promise.all(promises);
      const totalTime = Date.now() - startTime;

      // All requests should succeed
      responses.forEach((response) => {
        expect(response.status).toBe(200);
      });

      // Average response time should be reasonable
      const avgResponseTime = totalTime / concurrentRequests;
      expect(avgResponseTime).toBeLessThan(200); // Under 200ms average

      console.log(
        `Handled ${concurrentRequests} concurrent searches in ${totalTime}ms (avg: ${avgResponseTime.toFixed(2)}ms)`
      );
    });
  });

  describe("Memory and Storage Patterns", () => {
    it("should handle documents with varying content sizes", async () => {
      const stub = getPrimaryDO();

      const docs = [
        // Small documents (tweets, short messages)
        ...Array.from({ length: 100 }, (_, i) => ({
          id: `small-${i}`,
          content: `Short message ${i}: Just shipped a new feature! 🚀`,
        })),
        // Medium documents (articles, documentation)
        ...Array.from({ length: 50 }, (_, i) => ({
          id: `medium-${i}`,
          content: `
            Article ${i}: This is a medium-length document that represents typical blog posts
            or documentation pages. It contains several paragraphs of content with technical
            information, code examples, and detailed explanations that would be common in
            real-world search scenarios. The content is substantial enough to test FTS5
            ranking and relevance algorithms effectively.
          `.repeat(3),
        })),
        // Large documents (guides, specifications)
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `large-${i}`,
          content:
            `
            Comprehensive Guide ${i}: This represents a large document like a technical
            specification, comprehensive tutorial, or detailed API documentation.
          `.repeat(20) + ` Contains unique identifier: large-guide-${i}`,
        })),
      ];

      const result = await stub.indexDocuments(docs);
      expect(result.success).toBe(true);
      expect(result.indexed).toBe(160);

      // Test search across different document sizes
      const smallSearchResponse = await stub.fetch("http://do/search?q=shipped feature");
      const mediumSearchResponse = await stub.fetch("http://do/search?q=technical information");
      const largeSearchResponse = await stub.fetch("http://do/search?q=comprehensive guide");

      expect(smallSearchResponse.status).toBe(200);
      expect(mediumSearchResponse.status).toBe(200);
      expect(largeSearchResponse.status).toBe(200);

      // Verify storage efficiency
      const stats = await stub.getStats();
      expect(stats.count).toBe(160);
      // Storage should be reasonable even with varied content sizes
      expect(stats.estimatedSize).toBeGreaterThan(1000);
      expect(stats.estimatedSize).toBeLessThan(10 * 1024 * 1024); // Under 10MB
    });
  });
});

function generateRealisticContent(index: number): string {
  const templates = [
    `JavaScript Tutorial ${index}: Learn modern ES6+ features including async/await, destructuring, and modules. This comprehensive guide covers React, Vue, and Angular frameworks.`,
    `Python Development Guide ${index}: Explore Django, Flask, and FastAPI for web development. Includes database integration, API design, and deployment strategies.`,
    `Database Design ${index}: Best practices for SQL and NoSQL databases. Covers indexing, normalization, transactions, and performance optimization techniques.`,
    `DevOps Handbook ${index}: Container orchestration with Docker and Kubernetes. CI/CD pipelines, monitoring, and infrastructure as code principles.`,
    `Machine Learning ${index}: Introduction to TensorFlow and PyTorch. Data preprocessing, model training, evaluation metrics, and deployment strategies.`,
  ];

  const template = templates[index % templates.length];

  // Add some randomness to make each document unique
  const randomTerms = ["scalable", "production-ready", "enterprise", "cloud-native", "microservices"];
  const randomTerm = randomTerms[index % randomTerms.length];

  return `${template} Key focus on ${randomTerm} architecture and best practices for modern development teams.`;
}
