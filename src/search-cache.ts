import { SEARCH_CONFIG } from "./config";
import type { SearchResult } from "./types";

/**
 * Search result cache using Cloudflare KV storage
 */

export interface CachedSearchResult {
  query: string;
  results: SearchResult[];
  timestamp: number;
  ttl: number;
}

/**
 * Generates a cache key for a search query
 */
export function getCacheKey(query: string, includeCold: boolean): string {
  // Normalize query for consistent caching
  const normalizedQuery = query.toLowerCase().trim();
  const coldSuffix = includeCold ? ":cold" : ":hot";
  return `search:${normalizedQuery}${coldSuffix}`;
}

/**
 * Determines the TTL for a query based on its characteristics
 */
export function getCacheTTL(query: string, commonTermsRatio: number): number {
  // Common queries get shorter TTL as they might change more frequently
  if (commonTermsRatio > 0.5) {
    return SEARCH_CONFIG.CACHE_TTL.COMMON_QUERY;
  }
  // Rare/specific queries can be cached longer
  return SEARCH_CONFIG.CACHE_TTL.RARE_QUERY;
}

/**
 * Gets cached search results from KV if available and not expired
 */
export async function getCachedResults(kv: KVNamespace, query: string, includeCold: boolean): Promise<SearchResult[] | null> {
  const key = getCacheKey(query, includeCold);

  try {
    const cached = await kv.get<CachedSearchResult>(key, { type: "json" });

    if (!cached) {
      return null;
    }

    // Check if cache is still valid
    const now = Date.now();
    if (now - cached.timestamp > cached.ttl) {
      // Cache expired
      return null;
    }

    console.log(`Cache hit for query: "${query}" (includeCold: ${includeCold})`);
    return cached.results;
  } catch (error) {
    console.error("Error reading from cache:", error);
    return null;
  }
}

/**
 * Stores search results in KV cache
 */
export async function setCachedResults(
  kv: KVNamespace,
  query: string,
  includeCold: boolean,
  results: SearchResult[],
  commonTermsRatio: number
): Promise<void> {
  const key = getCacheKey(query, includeCold);
  const ttl = getCacheTTL(query, commonTermsRatio);

  const cacheEntry: CachedSearchResult = {
    query,
    results,
    timestamp: Date.now(),
    ttl,
  };

  try {
    // Store in KV with expiration
    await kv.put(key, JSON.stringify(cacheEntry), {
      expirationTtl: Math.floor(ttl / 1000), // KV expects seconds, not milliseconds
    });

    console.log(`Cached results for query: "${query}" (TTL: ${ttl}ms)`);
  } catch (error) {
    console.error("Error writing to cache:", error);
    // Non-critical error, continue without caching
  }
}

/**
 * Invalidates cache entries matching a pattern (useful for updates)
 */
export async function invalidateCache(kv: KVNamespace, pattern?: string): Promise<void> {
  try {
    if (!pattern) {
      // Clear all search cache
      const list = await kv.list({ prefix: "search:" });
      const deletePromises = list.keys.map((key) => kv.delete(key.name));
      await Promise.all(deletePromises);
      console.log("Cleared all search cache entries");
    } else {
      // Clear specific pattern
      const list = await kv.list({ prefix: `search:${pattern}` });
      const deletePromises = list.keys.map((key) => kv.delete(key.name));
      await Promise.all(deletePromises);
      console.log(`Cleared cache entries matching pattern: ${pattern}`);
    }
  } catch (error) {
    console.error("Error invalidating cache:", error);
  }
}
