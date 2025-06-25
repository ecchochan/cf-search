import { analyzeQuery, estimateTermMatches, preprocessContent, preprocessQuery } from "@/content-processor";
import { describe, expect, it } from "vitest";

describe("Content Processor", () => {
  describe("preprocessContent", () => {
    it("should remove stop words", () => {
      const content = "The cat is on the mat and the dog is in the house";
      const result = preprocessContent(content);
      // "The", "is", "on", "the", "and", "in", "the" should be removed
      expect(result).toBe("mat house");
    });

    it("should remove common terms", () => {
      const content = "This meme is funny and the cat video is trending";
      const result = preprocessContent(content);
      // "This", "meme", "is", "funny", "and", "the", "cat", "video", "is", "trending" should be removed
      expect(result).toBe("");
    });

    it("should keep specific terms", () => {
      const content = "JavaScript programming tutorial about React hooks implementation";
      const result = preprocessContent(content);
      expect(result).toBe("javascript programming tutorial react hooks implementation");
    });

    it("should handle mixed content", () => {
      const content = "The amazing JavaScript cat meme tutorial is very funny";
      const result = preprocessContent(content);
      // Keep: javascript, tutorial
      expect(result).toBe("javascript tutorial");
    });

    it("should handle empty or invalid input", () => {
      expect(preprocessContent("")).toBe("");
      expect(preprocessContent(null as any)).toBe("");
      expect(preprocessContent(undefined as any)).toBe("");
      expect(preprocessContent(123 as any)).toBe("");
    });

    it("should filter out very short and very long words", () => {
      const content = "a I JavaScript ab programmingreallylongwordthatisover50characterslong normal";
      const result = preprocessContent(content);
      // "a", "I" are too short; the 50+ char word is too long
      expect(result).toBe("javascript ab normal");
    });

    it("should handle special characters", () => {
      const content = "React.js, Vue.js, and Angular! What's your favorite?";
      const result = preprocessContent(content);
      // "What's" becomes "what s" but "s" is filtered out as too short
      expect(result).toBe("react js vue js angular favorite");
    });
  });

  describe("analyzeQuery", () => {
    it("should identify queries with too many common terms", () => {
      const result = analyzeQuery("cat meme funny video");
      expect(result.isValid).toBe(true);
      expect(result.isTooCommon).toBe(true);
      expect(result.commonTermsRatio).toBe(1); // 100% common terms
      expect(result.estimatedCost).toBe("high");
    });

    it("should accept queries with specific terms", () => {
      const result = analyzeQuery("JavaScript React tutorial");
      expect(result.isValid).toBe(true);
      expect(result.isTooCommon).toBe(false);
      expect(result.commonTermsRatio).toBe(0);
      expect(result.estimatedCost).toBe("low");
    });

    it("should handle mixed queries", () => {
      const result = analyzeQuery("funny JavaScript meme tutorial");
      expect(result.isValid).toBe(true);
      expect(result.isTooCommon).toBe(false);
      expect(result.commonTermsRatio).toBe(0.5); // 50% common terms
      // With 50% common terms, it's classified as "high" cost
      expect(result.estimatedCost).toBe("high");
    });

    it("should reject queries above 80% common terms threshold", () => {
      const result = analyzeQuery("the cat is funny and meme");
      expect(result.isValid).toBe(true);
      expect(result.isTooCommon).toBe(true);
      expect(result.commonTermsRatio).toBeGreaterThan(0.8);
      expect(result.reason).toContain("too many common terms");
    });

    it("should handle empty queries", () => {
      const result = analyzeQuery("");
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Empty or invalid query");
    });

    it("should handle queries with only stop words", () => {
      const result = analyzeQuery("the and or but");
      expect(result.isValid).toBe(true);
      expect(result.isTooCommon).toBe(true);
      expect(result.commonTermsRatio).toBe(1);
    });
  });

  describe("preprocessQuery", () => {
    it("should remove stop words but keep common terms", () => {
      const query = "the cat and meme";
      const result = preprocessQuery(query);
      // Remove "the" and "and", but keep "cat" and "meme"
      expect(result).toBe("cat meme");
    });

    it("should preserve original case for non-stop words", () => {
      const query = "The JavaScript and React";
      const result = preprocessQuery(query);
      expect(result).toBe("JavaScript React");
    });

    it("should handle queries with only stop words", () => {
      const query = "the and or but in on at";
      const result = preprocessQuery(query);
      expect(result).toBe("");
    });

    it("should filter short words", () => {
      const query = "a I JavaScript go programming";
      const result = preprocessQuery(query);
      expect(result).toBe("JavaScript go programming");
    });
  });

  describe("estimateTermMatches", () => {
    const totalDocs = 1_000_000;

    it("should estimate high matches for stop words", () => {
      const matches = estimateTermMatches("the", totalDocs);
      expect(matches).toBe(800_000); // 80% of docs
    });

    it("should estimate moderate matches for common terms", () => {
      const matches = estimateTermMatches("cat", totalDocs);
      expect(matches).toBe(300_000); // 30% of docs
    });

    it("should estimate low matches for specific long terms", () => {
      const matches = estimateTermMatches("javascript", totalDocs);
      expect(matches).toBe(1_000); // 0.1% of docs
    });

    it("should estimate based on term length", () => {
      const short = estimateTermMatches("api", totalDocs);
      const medium = estimateTermMatches("tutorial", totalDocs);
      const long = estimateTermMatches("implementation", totalDocs);

      expect(short).toBe(50_000); // 5% for 3 chars
      expect(medium).toBe(10_000); // 1% for 8 chars
      expect(long).toBe(1_000); // 0.1% for >8 chars
    });

    it("should handle edge cases", () => {
      expect(estimateTermMatches("", totalDocs)).toBe(50_000); // Default to 5%
      // "a" is a stop word, so it estimates 80% match rate
      expect(estimateTermMatches("a", totalDocs)).toBe(800_000); // Stop word
    });
  });
});
