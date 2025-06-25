import { COMMON_TERMS, STOP_WORDS } from "./config";

/**
 * Content preprocessing utilities for optimizing search index size and performance
 */

/**
 * Preprocesses content by removing stop words and common terms
 * This significantly reduces index size and improves search performance
 *
 * @param content - The raw content to preprocess
 * @returns The preprocessed content with stop words and common terms removed
 */
export function preprocessContent(content: string): string {
  if (!content || typeof content !== "string") {
    return "";
  }

  // Convert to lowercase and split into words
  const words = content
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ") // Replace non-word chars with spaces
    .split(/\s+/)
    .filter((word) => word.length > 0);

  // Filter out stop words and common terms
  const filteredWords = words.filter((word) => {
    // Keep words that are:
    // 1. Not in stop words list
    // 2. Not in common terms list
    // 3. Not too short (less than 2 chars)
    // 4. Not too long (more than 50 chars - likely garbage)
    return word.length >= 2 && word.length <= 50 && !STOP_WORDS.has(word) && !COMMON_TERMS.has(word);
  });

  // Rejoin words with single spaces
  return filteredWords.join(" ").trim();
}

/**
 * Analyzes a search query to determine its complexity and potential cost
 *
 * @param query - The search query to analyze
 * @returns Analysis result with cost estimation and recommendations
 */
export function analyzeQuery(query: string): {
  isValid: boolean;
  isTooCommon: boolean;
  commonTermsRatio: number;
  estimatedCost: "low" | "medium" | "high";
  reason: string | undefined;
} {
  if (!query || typeof query !== "string") {
    return {
      isValid: false,
      isTooCommon: false,
      commonTermsRatio: 0,
      estimatedCost: "low",
      reason: "Empty or invalid query",
    };
  }

  // Split query into words
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return {
      isValid: false,
      isTooCommon: false,
      commonTermsRatio: 0,
      estimatedCost: "low",
      reason: "No valid search terms",
    };
  }

  // Count common terms
  const commonTermCount = words.filter((word) => STOP_WORDS.has(word) || COMMON_TERMS.has(word)).length;

  const commonTermsRatio = commonTermCount / words.length;

  // Determine if query is too common
  const isTooCommon = commonTermsRatio > 0.8; // More than 80% common terms

  // Estimate cost based on query composition
  let estimatedCost: "low" | "medium" | "high";
  if (commonTermsRatio === 0) {
    estimatedCost = "low"; // All specific terms
  } else if (commonTermsRatio < 0.5) {
    estimatedCost = "medium"; // Mix of common and specific
  } else {
    estimatedCost = "high"; // Mostly common terms
  }

  return {
    isValid: true,
    isTooCommon,
    commonTermsRatio,
    estimatedCost,
    reason: isTooCommon ? "Query contains too many common terms" : undefined,
  };
}

/**
 * Preprocesses a search query by removing only stop words (not common terms)
 * This is less aggressive than content preprocessing since users might
 * legitimately want to search for common terms
 *
 * @param query - The search query to preprocess
 * @returns The preprocessed query
 */
export function preprocessQuery(query: string): string {
  if (!query || typeof query !== "string") {
    return "";
  }

  // Split query but preserve original case for now
  const words = query
    .replace(/[^\w\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);

  // Filter out only stop words (keep common terms for queries)
  const filteredWords = words.filter((word) => {
    const lowerWord = word.toLowerCase();
    return lowerWord.length >= 2 && !STOP_WORDS.has(lowerWord);
  });

  return filteredWords.join(" ").trim();
}

/**
 * Estimates the number of documents that might match a given term
 * This is a heuristic based on term type
 *
 * @param term - The search term
 * @param totalDocs - Total number of documents in the index
 * @returns Estimated number of matching documents
 */
export function estimateTermMatches(term: string, totalDocs: number): number {
  const lowerTerm = term.toLowerCase();

  // If it's a stop word or common term, assume high match rate
  if (STOP_WORDS.has(lowerTerm)) {
    return Math.floor(totalDocs * 0.8); // 80% of docs
  }

  if (COMMON_TERMS.has(lowerTerm)) {
    return Math.floor(totalDocs * 0.3); // 30% of docs
  }

  // For specific terms, assume lower match rate
  // Longer terms are likely more specific
  if (lowerTerm.length > 8) {
    return Math.floor(totalDocs * 0.001); // 0.1% of docs
  } else if (lowerTerm.length > 5) {
    return Math.floor(totalDocs * 0.01); // 1% of docs
  } else {
    return Math.floor(totalDocs * 0.05); // 5% of docs
  }
}
