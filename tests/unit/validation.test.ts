import { describe, expect, it } from "vitest";
import { validateDocument, validateDocuments } from "../../src/types";

describe("Document Validation", () => {
  describe("validateDocument", () => {
    it("should validate a correct document", () => {
      const doc = { id: "doc1", content: "This is test content" };
      const result = validateDocument(doc);

      expect(result.valid).toBe(true);
      expect(result.data).toEqual(doc);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject non-object input", () => {
      const result = validateDocument("not an object");

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.field).toBe("document");
      expect(result.errors[0]?.message).toBe("Document must be an object");
    });

    it("should reject null input", () => {
      const result = validateDocument(null);

      expect(result.valid).toBe(false);
      expect(result.errors[0]?.field).toBe("document");
    });

    it("should reject missing id", () => {
      const doc = { content: "This is test content" };
      const result = validateDocument(doc);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "id")).toBe(true);
      expect(result.errors.find((e) => e.field === "id")?.message).toBe("ID must be a string");
    });

    it("should reject non-string id", () => {
      const doc = { id: 123, content: "This is test content" };
      const result = validateDocument(doc);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "id")).toBe(true);
    });

    it("should reject empty id", () => {
      const doc = { id: "", content: "This is test content" };
      const result = validateDocument(doc);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.field === "id")?.message).toBe("ID cannot be empty");
    });

    it("should reject id that is too long", () => {
      const longId = "a".repeat(256);
      const doc = { id: longId, content: "Test content" };
      const result = validateDocument(doc);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.field === "id")?.message).toBe("ID cannot be longer than 255 characters");
    });

    it("should reject missing content", () => {
      const doc = { id: "doc1" };
      const result = validateDocument(doc);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "content")).toBe(true);
      expect(result.errors.find((e) => e.field === "content")?.message).toBe("Content must be a string");
    });

    it("should reject non-string content", () => {
      const doc = { id: "doc1", content: 123 };
      const result = validateDocument(doc);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "content")).toBe(true);
    });

    it("should reject empty content", () => {
      const doc = { id: "doc1", content: "" };
      const result = validateDocument(doc);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.field === "content")?.message).toBe("Content cannot be empty");
    });

    it("should handle multiple validation errors", () => {
      const doc = { id: 123, content: "" };
      const result = validateDocument(doc);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(result.errors.some((e) => e.field === "id")).toBe(true);
      expect(result.errors.some((e) => e.field === "content")).toBe(true);
    });

    it("should preserve additional properties", () => {
      const doc = {
        id: "doc1",
        content: "This is test content",
        category: "test",
        timestamp: 123456789,
      };
      const result = validateDocument(doc);

      expect(result.valid).toBe(true);
      expect(result.data).toEqual(doc);
      expect(result.data?.category).toBe("test");
      expect(result.data?.timestamp).toBe(123456789);
    });
  });

  describe("validateDocuments", () => {
    it("should validate an array of correct documents", () => {
      const docs = [
        { id: "doc1", content: "Content 1" },
        { id: "doc2", content: "Content 2" },
      ];
      const result = validateDocuments(docs);

      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject non-array input", () => {
      const result = validateDocuments("not an array");

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.field).toBe("documents");
      expect(result.errors[0]?.message).toBe("Input must be an array");
    });

    it("should validate empty array", () => {
      const result = validateDocuments([]);

      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should collect errors from multiple invalid documents", () => {
      const docs = [
        { id: "doc1", content: "Valid content" },
        { id: 123, content: "Invalid id" },
        { id: "doc3", content: "" },
        { content: "Missing id" },
      ];
      const result = validateDocuments(docs);

      expect(result.valid).toBe(false);
      expect(result.data).toHaveLength(1); // Only the valid document
      expect(result.errors).toHaveLength(3); // 3 errors from 3 invalid documents

      // Check that errors include document index
      expect(result.errors.some((e) => e.field.includes("documents[1]"))).toBe(true);
      expect(result.errors.some((e) => e.field.includes("documents[2]"))).toBe(true);
      expect(result.errors.some((e) => e.field.includes("documents[3]"))).toBe(true);
    });

    it("should return only valid documents when some are invalid", () => {
      const docs = [
        { id: "doc1", content: "Valid content 1" },
        { id: 123, content: "Invalid id" },
        { id: "doc3", content: "Valid content 3" },
      ];
      const result = validateDocuments(docs);

      expect(result.valid).toBe(false);
      expect(result.data).toHaveLength(2);
      expect(result.data?.[0]?.id).toBe("doc1");
      expect(result.data?.[1]?.id).toBe("doc3");
    });
  });
});
