import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Cloudflare Search Worker", () => {
  it("should return 404 for unknown endpoints", async () => {
    const response = await SELF.fetch("http://example.com/unknown");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("should require query parameter for search", async () => {
    const response = await SELF.fetch("http://example.com/search");
    expect(response.status).toBe(400);

    const result = (await response.json()) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Bad request: missing query parameter");
  });

  it("should reject malformed JSON for indexing", async () => {
    const response = await SELF.fetch("http://example.com/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid json",
    });

    expect(response.status).toBe(400);
    const result = (await response.json()) as any;
    expect(result.success).toBe(false);
  });

  it("should handle search requests with empty results", async () => {
    const response = await SELF.fetch("http://example.com/search?q=nonexistent");
    expect(response.status).toBe(200);

    const results = await response.json();
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  it("should accept valid document indexing requests", async () => {
    const docs = [{ id: "test-doc-1", content: "This is a test document for indexing" }];

    const response = await SELF.fetch("http://example.com/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(docs),
    });

    expect(response.status).toBe(202);
    const result = (await response.json()) as any;
    expect(result.success).toBe(true);
    expect(result.message).toContain("1 documents queued");
  });
});
