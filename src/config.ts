import type { ConfigureRequest, ReplicaInfo } from "./types";

/**
 * Configuration for the Cloudflare Search Service
 * This file contains all the configurable parameters for the search service
 */

// Environment type for configuration
export type Environment = "development" | "staging" | "production";

// Time constants for better readability
export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
} as const;

const BYTES_PER_DOC = 2_000; // Approximate number of bytes per document

// Storage size estimates (documents per GB)
export const STORAGE = {
  BYTES_PER_DOC,
  DOCS_PER_GB: 1_000_000_000 / BYTES_PER_DOC, // 500,000, approximate number of documents per GB
  MAX_STORAGE_GB: 10, // Cloudflare DO storage limit
  SAFETY_MARGIN: 0.9, // Use 90% of max storage
} as const;

// Default configuration values
export const DEFAULTS = {
  ALARM_INTERVAL: 30 * TIME.SECOND,
  PURGE_THRESHOLD: STORAGE.DOCS_PER_GB * STORAGE.MAX_STORAGE_GB * STORAGE.SAFETY_MARGIN,
  PURGE_TARGET_PERCENTAGE: 0.8, // Purge down to 80% of threshold
  COLD_STORAGE_THRESHOLD: STORAGE.DOCS_PER_GB * STORAGE.MAX_STORAGE_GB * STORAGE.SAFETY_MARGIN, // 5GB per cold storage DO
  SEARCH_TIMEOUT: 5 * TIME.SECOND,
  SYNC_BATCH_SIZE: 1000,
  INDEX_BATCH_SIZE: 100,
} as const;

// Cloudflare regions for global distribution
export const CF_REGIONS = {
  // Americas
  NORTH_AMERICA_WEST: "wnam",
  NORTH_AMERICA_EAST: "enam",
  SOUTH_AMERICA: "sam",

  // Europe
  WESTERN_EUROPE: "weur",
  EASTERN_EUROPE: "eeur",

  // Asia Pacific
  SOUTH_EAST_ASIA: "seas",
  NORTH_EAST_ASIA: "neas",
  SOUTH_ASIA: "sas",
  OCEANIA: "oc",

  // Middle East & Africa
  MIDDLE_EAST: "me",
  AFRICA: "afr",
} as const;

export type CloudflareRegion = (typeof CF_REGIONS)[keyof typeof CF_REGIONS];

// Stop words - common English words that don't add search value
export const STOP_WORDS = new Set([
  // Articles
  "a",
  "an",
  "the",
  // Conjunctions
  "and",
  "or",
  "but",
  "nor",
  "for",
  "yet",
  "so",
  // Prepositions
  "in",
  "on",
  "at",
  "to",
  "from",
  "with",
  "by",
  "about",
  "against",
  "between",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  // Pronouns
  "i",
  "me",
  "my",
  "myself",
  "we",
  "our",
  "ours",
  "ourselves",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "he",
  "him",
  "his",
  "himself",
  "she",
  "her",
  "hers",
  "herself",
  "it",
  "its",
  "itself",
  "they",
  "them",
  "their",
  "theirs",
  "themselves",
  // Common verbs
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "do",
  "does",
  "did",
  "doing",
  // Other common words
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "very",
  "can",
  "will",
  "just",
  "should",
  "could",
  "would",
  "may",
  "might",
  "must",
  "shall",
  "not",
  "no",
  "yes",
]);

// Common terms - domain-specific high-frequency terms that are too broad for effective search
export const COMMON_TERMS = new Set([
  // Social media generic terms
  "post",
  "posts",
  "user",
  "users",
  "comment",
  "comments",
  "like",
  "likes",
  "share",
  "shares",
  "view",
  "views",
  "video",
  "videos",
  "image",
  "images",
  "photo",
  "photos",
  "picture",
  "pictures",
  // Meme-specific common terms
  "meme",
  "memes",
  "funny",
  "lol",
  "lmao",
  "fun",
  "joke",
  "jokes",
  "humor",
  "humour",
  "viral",
  "trending",
  "hot",
  "new",
  "best",
  "top",
  "popular",
  "epic",
  "awesome",
  "amazing",
  "great",
  "good",
  "bad",
  "wtf",
  "omg",
  // Animals (commonly used in memes)
  "cat",
  "cats",
  "dog",
  "dogs",
  "pet",
  "pets",
  "animal",
  "animals",
  // Time-related
  "today",
  "yesterday",
  "tomorrow",
  "now",
  "latest",
  "recent",
  "old",
  "year",
  "month",
  "day",
  "time",
  // Generic content descriptors
  "content",
  "thing",
  "things",
  "stuff",
  "item",
  "items",
  "one",
  "two",
  "first",
  "last",
  "next",
]);

// Search configuration
export const SEARCH_CONFIG = {
  MAX_RESULTS_PER_PAGE: 100,
  DEFAULT_PAGE_SIZE: 20,
  MAX_QUERY_LENGTH: 200,
  MIN_QUERY_LENGTH: 2,
  CACHE_TTL: {
    COMMON_QUERY: 5 * TIME.MINUTE,
    RARE_QUERY: 1 * TIME.HOUR,
  },
  // Thresholds for query complexity
  QUERY_COMPLEXITY: {
    MAX_COMMON_TERMS_RATIO: 0.8, // Reject if >80% of query is common terms
    MAX_ESTIMATED_ROWS: 1_000_000, // Reject if query would scan >1M rows
  },
  // Query optimization settings
  OPTIMIZATION: {
    // Result limits based on query cost
    HIGH_COST_LIMIT: 50, // Max results for expensive queries
    MEDIUM_COST_LIMIT: 100, // Max results for medium-cost queries
    LOW_COST_LIMIT: 200, // Max results for low-cost queries

    // Query preprocessing settings
    ENABLE_STOP_WORD_REMOVAL: true,
    ENABLE_QUERY_COST_ANALYSIS: true,
    ENABLE_RESULT_LIMITING: true,

    // Performance settings
    SEARCH_TIMEOUT_MS: 5000, // Max search time in milliseconds
    MAX_COLD_STORAGE_SCAN: 5, // Max number of cold storage DOs to search

    // Cost control settings
    REJECT_EXPENSIVE_QUERIES: true,
    LOG_QUERY_ANALYSIS: true,
    CACHE_EXPENSIVE_QUERIES: true,
  },
} as const;

// Primary DO configuration
export const PRIMARY_DO = {
  NAME: "primary-search-index-v1",
  LOCATION: CF_REGIONS.NORTH_AMERICA_WEST,
} as const;

// Configuration builder for different environments
export const buildConfig = (env: Environment = "development"): ConfigureRequest => {
  const baseConfig: ConfigureRequest = {
    alarmIntervalMs: DEFAULTS.ALARM_INTERVAL,
    purgeThresholdDocs: DEFAULTS.PURGE_THRESHOLD,
    purgeTargetDocs: Math.floor(DEFAULTS.PURGE_THRESHOLD * DEFAULTS.PURGE_TARGET_PERCENTAGE),
    coldStoragePrefix: `${env}-cold-storage`,
    coldStorageThresholdDocs: DEFAULTS.COLD_STORAGE_THRESHOLD,
    idType: "string", // Default to string IDs for backward compatibility
  };

  switch (env) {
    case "development":
      return {
        ...baseConfig,
        alarmIntervalMs: 10 * TIME.SECOND, // Faster sync for development
        purgeThresholdDocs: 1000, // Lower threshold for testing
        purgeTargetDocs: 800,
        coldStorageThresholdDocs: 500, // Smaller cold storage for testing
        coldStoragePrefix: "dev-cold",
        idType: "string", // Keep string for development testing
        replicas: [{ type: "local", id: "dev-replica-1" }],
      };

    case "staging":
      return {
        ...baseConfig,
        coldStorageThresholdDocs: STORAGE.DOCS_PER_GB * 2, // 2GB per cold storage
        coldStoragePrefix: "staging-cold",
        idType: "string", // Use string for staging
        replicas: [
          { type: "region", name: CF_REGIONS.WESTERN_EUROPE },
          { type: "region", name: CF_REGIONS.SOUTH_EAST_ASIA },
        ],
      };

    case "production":
      return {
        ...baseConfig,
        coldStoragePrefix: "prod-cold",
        idType: "string", // Keep string for backward compatibility - can be overridden
        replicas: buildGlobalReplicas(),
      };

    default:
      return baseConfig;
  }
};

// Build replicas for all regions except the primary
export const buildGlobalReplicas = (excludeRegion: CloudflareRegion = PRIMARY_DO.LOCATION): ReplicaInfo[] => {
  return Object.entries(CF_REGIONS)
    .filter(([_, region]) => region !== excludeRegion)
    .map(([_, region]) => ({ type: "region", name: region }) as ReplicaInfo);
};

// Helper to build custom replica configuration
export const buildReplicas = (regions: CloudflareRegion[], localReplicas: number = 0): ReplicaInfo[] => {
  const regionalReplicas: ReplicaInfo[] = regions.map((region) => ({
    type: "region",
    name: region,
  }));

  const localReplicaList: ReplicaInfo[] = Array.from({ length: localReplicas }, (_, i) => ({
    type: "local",
    id: `local-replica-${i + 1}`,
  }));

  return [...regionalReplicas, ...localReplicaList];
};

// Validation helpers
export const validateConfig = (config: ConfigureRequest): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  if (config.alarmIntervalMs && config.alarmIntervalMs < TIME.SECOND) {
    errors.push("Alarm interval must be at least 1 second");
  }

  if (config.purgeThresholdDocs && config.purgeTargetDocs) {
    if (config.purgeTargetDocs >= config.purgeThresholdDocs) {
      errors.push("Purge target must be less than purge threshold");
    }
  }

  if (config.replicas) {
    const regionNames = new Set<string>();
    const localIds = new Set<string>();

    for (const replica of config.replicas) {
      if (replica.type === "region") {
        if (!replica.name) {
          errors.push("Regional replica must have a name");
        } else if (regionNames.has(replica.name)) {
          errors.push(`Duplicate regional replica: ${replica.name}`);
        } else {
          regionNames.add(replica.name);
        }
      } else if (replica.type === "local") {
        if (!replica.id) {
          errors.push("Local replica must have an id");
        } else if (localIds.has(replica.id)) {
          errors.push(`Duplicate local replica: ${replica.id}`);
        } else {
          localIds.add(replica.id);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
};

// Default configuration for immediate use
export const CF_SEARCH_CONFIG = buildConfig((globalThis as any).ENVIRONMENT || "development");

// Export convenience functions for common configurations
export const configs = {
  development: () => buildConfig("development"),
  staging: () => buildConfig("staging"),
  production: () => buildConfig("production"),
  custom: (overrides: Partial<ConfigureRequest>) => ({
    ...CF_SEARCH_CONFIG,
    ...overrides,
  }),
} as const;
