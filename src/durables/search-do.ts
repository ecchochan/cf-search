/**
 * This is the Durable Object class that powers the search service.
 * A single class is used for the primary, regional, and local replicas.
 * Its behavior is determined by its environment and configuration.
 *
 * It uses SQLite with FTS5 for powerful and fast full-text search.
 */

import type {
  ConfigureRequest,
  DOConfig,
  Document,
  DOStats,
  Env,
  IndexResult,
  LogContext,
  ReplicaInfo,
  SearchIndexDOStub,
  SearchParams,
  SearchResult,
  StorageMetrics,
  SyncResult,
} from "@/types";
import { SearchLogger, validateDocuments } from "@/types";
import { analyzeQuery, preprocessContent, preprocessQuery } from "../content-processor";
import { invalidateCache } from "../search-cache";

import { DurableObject } from "cloudflare:workers";

export class SearchIndexDO extends DurableObject<Env> {
  private state: DurableObjectState;
  private config: DOConfig;
  private logger: SearchLogger;
  private performanceTracker: Map<string, number> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.config = {};

    // Initialize logger with context
    const logContext: LogContext = {
      service: "cf-search",
      version: "1.0.0",
      environment: (globalThis as any).ENVIRONMENT || "development",
      doId: state.id.toString(),
      doType: this.getDOType(),
    };
    this.logger = new SearchLogger(logContext);

    // blockConcurrencyWhile ensures that other events wait until initialization is complete
    this.state.blockConcurrencyWhile(async () => {
      await this.initialize();
    });
  }

  private getDOType(): "primary" | "replica" | "cold-storage" {
    const doId = this.state.id.toString();
    if (doId.includes("cold")) return "cold-storage";
    if (doId.includes("replica")) return "replica";
    return "primary";
  }

  private startTimer(operation: string): string {
    const timerKey = `${operation}-${Date.now()}-${Math.random()}`;
    this.performanceTracker.set(timerKey, Date.now());
    return timerKey;
  }

  private endTimer(timerKey: string): number {
    const startTime = this.performanceTracker.get(timerKey);
    if (!startTime) return 0;

    const duration = Date.now() - startTime;
    this.performanceTracker.delete(timerKey);
    return duration;
  }

  /**
   * Initializes the DO instance. Creates the SQLite database and table if they don't exist,
   * and loads the configuration from persistent storage.
   */
  private async initialize(): Promise<void> {
    const timer = this.startTimer("initialize");

    try {
      // Load configuration from persistent storage first
      const storedConfig = await this.state.storage.get<DOConfig>("config");
      this.config = storedConfig || {};

      // The first transaction in a DO's lifetime is a migration
      await this.state.storage.transaction(async (txn) => {
        const version = (await txn.get<number>("db_version")) || 0;
        if (version < 1) {
          this.logger.info("Initializing database schema", { version: 1 });

          // Create optimized FTS5 table based on ID type
          const idType = this.config.idType || "string";

          if (idType === "integer") {
            // For integer IDs, use content_rowid optimization
            this.state.storage.sql.exec(
              "CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(content, content_rowid=id, tokenize = 'porter unicode61');"
            );
            this.logger.info("Created FTS5 table optimized for integer IDs");
          } else {
            // For string IDs, store ID as unindexed column
            this.state.storage.sql.exec(
              "CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, content, tokenize = 'porter unicode61');"
            );
            this.logger.info("Created FTS5 table for string IDs");
          }

          await txn.put("db_version", 1);
        }
      });

      const duration = this.endTimer(timer);
      this.logger.searchMetrics({
        operation: "configure",
        status: "success",
        duration_ms: duration,
      });
    } catch (error) {
      const duration = this.endTimer(timer);
      this.logger.searchMetrics({
        operation: "configure",
        status: "error",
        duration_ms: duration,
        error_type: error instanceof Error ? error.constructor.name : "UnknownError",
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Simplified fetch handler for essential external HTTP endpoints only
   * Most internal operations now use native RPC methods
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/search":
          return await this.handleSearchHTTP(request, url);
        case "/stats":
          return await this.handleStatsHTTP();
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ============================================================================
  // NATIVE RPC METHODS - Used for internal DO-to-DO communication
  // ============================================================================

  /**
   * RPC Method: Index documents (replaces /internal-index endpoint)
   */
  async indexDocuments(documents: Document[]): Promise<IndexResult> {
    const timer = this.startTimer("index");

    try {
      if (this.config.isReadOnly) {
        const duration = this.endTimer(timer);
        this.logger.searchMetrics({
          operation: "index",
          status: "error",
          duration_ms: duration,
          error_type: "ReadOnlyError",
          error_message: "Attempted to index on read-only DO",
        });
        return {
          success: false,
          indexed: 0,
          error: "This is a read-only cold storage DO",
        };
      }

      const idType = this.config.idType || "string";
      const validation = validateDocuments(documents, idType);

      if (!validation.valid) {
        const duration = this.endTimer(timer);
        this.logger.searchMetrics({
          operation: "index",
          status: "error",
          duration_ms: duration,
          document_count: documents.length,
          error_type: "ValidationError",
          error_message: `Document validation failed: ${validation.errors.length} errors`,
        });

        this.logger.error("Document validation failed", { errors: validation.errors });

        return {
          success: false,
          indexed: 0,
          error: "Invalid documents",
          details: JSON.stringify(validation.errors),
        };
      }

      if (validation.data && validation.data.length > 0) {
        await this.indexDocumentsInternal(validation.data);

        const duration = this.endTimer(timer);
        this.logger.searchMetrics({
          operation: "index",
          status: "success",
          duration_ms: duration,
          document_count: validation.data.length,
          batch_size: validation.data.length,
        });

        // Update storage metrics
        await this.logStorageMetrics();

        // Invalidate search cache after successful indexing
        if (this.env.SEARCH_CACHE && validation.data.length > 0) {
          await invalidateCache(this.env.SEARCH_CACHE);
          this.logger.info("Search cache invalidated after indexing operation", {
            indexedCount: validation.data.length,
          });
        }

        return {
          success: true,
          indexed: validation.data.length,
        };
      }

      const duration = this.endTimer(timer);
      this.logger.searchMetrics({
        operation: "index",
        status: "success",
        duration_ms: duration,
        document_count: 0,
      });

      return {
        success: true,
        indexed: 0,
      };
    } catch (error) {
      const duration = this.endTimer(timer);
      this.logger.searchMetrics({
        operation: "index",
        status: "error",
        duration_ms: duration,
        error_type: error instanceof Error ? error.constructor.name : "UnknownError",
        error_message: error instanceof Error ? error.message : String(error),
      });

      this.logger.error("Error processing documents", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        indexed: 0,
        error: "Failed to process documents",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * RPC Method: Sync documents (replaces /internal-sync endpoint)
   */
  async syncDocuments(documents: Document[]): Promise<SyncResult> {
    const timer = this.startTimer("sync");

    try {
      if (this.config.isReadOnly) {
        const duration = this.endTimer(timer);
        this.logger.searchMetrics({
          operation: "sync",
          status: "error",
          duration_ms: duration,
          error_type: "ReadOnlyError",
          error_message: "Attempted to sync to read-only DO",
        });
        return {
          success: false,
          synced: 0,
          error: "This is a read-only cold storage DO",
        };
      }

      const idType = this.config.idType || "string";
      const validation = validateDocuments(documents, idType);

      if (!validation.valid) {
        const duration = this.endTimer(timer);
        this.logger.searchMetrics({
          operation: "sync",
          status: "error",
          duration_ms: duration,
          document_count: documents.length,
          error_type: "ValidationError",
          error_message: `Document validation failed during sync: ${validation.errors.length} errors`,
        });

        this.logger.error("Document validation failed during sync", { errors: validation.errors });

        return {
          success: false,
          synced: 0,
          error: "Invalid documents",
          details: JSON.stringify(validation.errors),
        };
      }

      if (validation.data && validation.data.length > 0) {
        await this.indexDocumentsInternal(validation.data);

        const duration = this.endTimer(timer);
        this.logger.searchMetrics({
          operation: "sync",
          status: "success",
          duration_ms: duration,
          document_count: validation.data.length,
          batch_size: validation.data.length,
        });

        // Invalidate search cache after successful sync
        if (this.env.SEARCH_CACHE && validation.data.length > 0) {
          await invalidateCache(this.env.SEARCH_CACHE);
          this.logger.info("Search cache invalidated after sync operation", {
            syncedCount: validation.data.length,
          });
        }

        return {
          success: true,
          synced: validation.data.length,
        };
      }

      const duration = this.endTimer(timer);
      this.logger.searchMetrics({
        operation: "sync",
        status: "success",
        duration_ms: duration,
        document_count: 0,
      });

      return {
        success: true,
        synced: 0,
      };
    } catch (error) {
      const duration = this.endTimer(timer);
      this.logger.searchMetrics({
        operation: "sync",
        status: "error",
        duration_ms: duration,
        error_type: error instanceof Error ? error.constructor.name : "UnknownError",
        error_message: error instanceof Error ? error.message : String(error),
      });

      this.logger.error("Error syncing documents", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        synced: 0,
        error: "Failed to sync documents",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * RPC Method: Perform search (replaces internal search calls)
   */
  async searchDocuments(params: SearchParams): Promise<SearchResult[]> {
    const timer = this.startTimer("search");
    const { query, includeCold = false, maxResults = 100 } = params;

    try {
      if (!query) {
        const duration = this.endTimer(timer);
        this.logger.searchMetrics({
          operation: "search",
          status: "error",
          duration_ms: duration,
          error_type: "ValidationError",
          error_message: "Missing query parameter",
        });
        return [];
      }

      // Search local data with result limits
      const results = this.search(query, maxResults);
      let totalResults = results.length;

      // If includeCold is requested and this is not a cold storage DO, search cold storage
      if (includeCold && !this.config.isReadOnly && this.config.currentColdStorageIndex) {
        const coldResults = await this.searchColdStorage(query, Math.max(0, maxResults - results.length));
        results.push(...coldResults);
        totalResults = results.length;

        // Re-sort combined results by rank and apply final limit
        results.sort((a, b) => a.rank - b.rank);
        if (results.length > maxResults) {
          results.splice(maxResults);
        }
      }

      const duration = this.endTimer(timer);

      // Log search metrics
      this.logger.searchMetrics({
        operation: "search",
        status: "success",
        duration_ms: duration,
        result_count: totalResults,
        query_length: query.length,
      });

      // Log business metrics for popular queries
      if (totalResults > 0) {
        this.logger.businessMetrics({
          total_searches: 1,
          success_rate: 1.0,
        });
      }

      return results;
    } catch (error) {
      const duration = this.endTimer(timer);
      this.logger.searchMetrics({
        operation: "search",
        status: "error",
        duration_ms: duration,
        query_length: query?.length,
        error_type: error instanceof Error ? error.constructor.name : "UnknownError",
        error_message: error instanceof Error ? error.message : String(error),
      });

      this.logger.error("Search operation failed", {
        query,
        includeCold,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }

  /**
   * RPC Method: Get stats (replaces /stats endpoint for internal calls)
   */
  async getStats(): Promise<DOStats> {
    try {
      const countCursor = this.state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
      const countResult = countCursor.toArray();
      const count = countResult[0]?.count || 0;

      // Use actual database size instead of estimation
      const actualSize = this.state.storage.sql.databaseSize;

      const stats: DOStats = {
        count,
        estimatedSize: actualSize, // Now contains actual size, not estimated
        ...(this.config.isReadOnly !== undefined && { isReadOnly: this.config.isReadOnly }),
      };

      return stats;
    } catch (error) {
      this.logger.error("Error getting stats", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        count: 0,
        estimatedSize: 0,
        isReadOnly: !!this.config.isReadOnly,
      };
    }
  }

  /**
   * RPC Method: Configure DO (replaces /configure endpoint for internal calls)
   */
  async configureRPC(config: ConfigureRequest): Promise<void> {
    await this.configure(config);
  }

  // ============================================================================
  // HTTP ENDPOINTS - For external API access only
  // ============================================================================

  /**
   * HTTP Handler: Search endpoint for external API
   */
  private async handleSearchHTTP(request: Request, url: URL): Promise<Response> {
    const query = url.searchParams.get("q");
    const includeCold = url.searchParams.get("includeCold") === "true";
    const maxResultsParam = url.searchParams.get("maxResults");

    let maxResults = 100; // Default value
    if (maxResultsParam) {
      const parsed = parseInt(maxResultsParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        maxResults = Math.min(parsed, 1000); // Cap at 1000 for HTTP endpoint
      }
    }

    if (!query) {
      return new Response(JSON.stringify({ error: "Missing query parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const results = await this.searchDocuments({ query, includeCold, maxResults });
      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("HTTP search error:", error);
      return new Response(JSON.stringify({ error: "Search failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  /**
   * HTTP Handler: Stats endpoint for external API
   */
  private async handleStatsHTTP(): Promise<Response> {
    try {
      const stats = await this.getStats();
      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      this.logger.error("Stats HTTP request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response("Internal server error", { status: 500 });
    }
  }

  /**
   * The alarm is used for periodic background tasks like syncing and purging data.
   */
  async alarm(): Promise<void> {
    console.log(`Alarm triggered for DO ${this.state.id.toString()}`);

    // Skip background tasks for cold storage DOs
    if (this.config.isReadOnly) {
      console.log("Cold storage DO - skipping background tasks");
      return;
    }

    // Sync to replicas if configured
    if (this.config.replicas?.length) {
      await this.syncToReplicas();
    }

    // Purge old data if configured
    if (this.config.purgeThresholdDocs) {
      await this.purgeOldData();
    }

    // Set the next alarm
    const interval = this.config.alarmIntervalMs || 60_000; // Default to 60 seconds
    await this.state.storage.setAlarm(Date.now() + interval);
    console.log(`Next alarm set in ${interval}ms`);
  }

  /**
   * Configures the DO's settings
   */
  private async configure(newConfig: ConfigureRequest): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    await this.state.storage.put("config", this.config);
    console.log("Configuration updated:", this.config);

    // Skip alarm setting in test environment to avoid isolated storage issues
    const isTestEnvironment = (globalThis as any).VITEST;

    if (!isTestEnvironment) {
      // Set initial alarm if not already set
      const currentAlarm = await this.state.storage.getAlarm();
      if (!currentAlarm) {
        console.log("Setting first alarm.");
        await this.state.storage.setAlarm(Date.now() + 5000); // Start in 5s
      }
    }
  }

  /**
   * Indexes a batch of documents into the SQLite FTS table using safe parameterized queries
   */
  private async indexDocumentsInternal(documents: Document[]): Promise<void> {
    if (!documents?.length) return;

    console.log(`Indexing ${documents.length} documents.`);

    try {
      const idType = this.config.idType || "string";

      // Chunk documents to respect 32-argument limit (15 docs × 2 params = 30 args)
      const CHUNK_SIZE = 15;

      for (let i = 0; i < documents.length; i += CHUNK_SIZE) {
        const chunk = documents.slice(i, i + CHUNK_SIZE);
        await this.indexDocumentChunk(chunk, idType);
      }

      console.log(`Successfully indexed ${documents.length} documents using parameterized queries`);
    } catch (error) {
      console.error("Failed to index documents:", error);
      throw new Error(`Indexing failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Indexes a chunk of documents using safe parameterized queries
   */
  private async indexDocumentChunk(chunk: Document[], idType: "string" | "integer"): Promise<void> {
    if (idType === "integer") {
      // For integer IDs, use REPLACE with rowid optimization and parameterized queries
      if (chunk.length === 1) {
        // Single document - simple parameterized query
        const doc = chunk[0]!;
        // Preprocess content to remove stop words and common terms
        const processedContent = preprocessContent(doc.content || "");
        const truncatedContent = processedContent.slice(0, 500);
        this.state.storage.sql.exec("REPLACE INTO documents(rowid, content) VALUES (?, ?)", doc.id, truncatedContent);
      } else {
        // Multiple documents - build safe VALUES list with parameterized queries
        const placeholders = chunk.map(() => "(?, ?)").join(", ");
        const values: (string | number)[] = [];

        chunk.forEach((doc) => {
          values.push(doc.id);
          // Preprocess content to remove stop words and common terms
          const processedContent = preprocessContent(doc.content || "");
          values.push(processedContent.slice(0, 500));
        });

        this.state.storage.sql.exec(`REPLACE INTO documents(rowid, content) VALUES ${placeholders}`, ...values);
      }
    } else {
      // For string IDs, use DELETE + INSERT approach with parameterized queries

      // First, delete existing documents with the same IDs
      if (chunk.length === 1) {
        this.state.storage.sql.exec("DELETE FROM documents WHERE id = ?", chunk[0]!.id);
      } else {
        const placeholders = chunk.map(() => "?").join(", ");
        const ids = chunk.map((doc) => doc.id);
        this.state.storage.sql.exec(`DELETE FROM documents WHERE id IN (${placeholders})`, ...ids);
      }

      // Then insert the new/updated documents
      if (chunk.length === 1) {
        const doc = chunk[0]!;
        // Preprocess content to remove stop words and common terms
        const processedContent = preprocessContent(doc.content || "");
        const truncatedContent = processedContent.slice(0, 500);
        this.state.storage.sql.exec("INSERT INTO documents (id, content) VALUES (?, ?)", doc.id, truncatedContent);
      } else {
        const placeholders = chunk.map(() => "(?, ?)").join(", ");
        const values: string[] = [];

        chunk.forEach((doc) => {
          values.push(doc.id);
          // Preprocess content to remove stop words and common terms
          const processedContent = preprocessContent(doc.content || "");
          values.push(processedContent.slice(0, 500));
        });

        this.state.storage.sql.exec(`INSERT INTO documents (id, content) VALUES ${placeholders}`, ...values);
      }
    }
  }

  /**
   * Performs a full-text search on the local SQLite database
   */
  private search(queryText: string, maxResults: number = 100): SearchResult[] {
    console.log(`Searching for: "${queryText}" (max results: ${maxResults})`);

    try {
      // Preprocess the query to remove stop words and optimize for search
      const processedQuery = preprocessQuery(queryText);

      if (!processedQuery || processedQuery.length === 0) {
        console.log("Query processed to empty string (all stop words)");
        return [];
      }

      // Analyze query complexity and cost
      const queryAnalysis = analyzeQuery(processedQuery);

      // Log query cost analysis
      this.logger.info("Query analysis", {
        originalQuery: queryText,
        processedQuery: processedQuery,
        estimatedCost: queryAnalysis.estimatedCost,
        commonTermsRatio: queryAnalysis.commonTermsRatio,
        isTooCommon: queryAnalysis.isTooCommon,
      });

      // Reject extremely expensive queries
      if (queryAnalysis.isTooCommon) {
        console.warn(
          `Rejecting expensive query: "${queryText}" (${queryAnalysis.commonTermsRatio * 100}% common terms)`
        );
        return [];
      }

      // Adjust max results based on query cost
      let effectiveMaxResults = maxResults;
      if (queryAnalysis.estimatedCost === "high") {
        effectiveMaxResults = Math.min(maxResults, 50); // Limit expensive queries
        console.log(`Limiting high-cost query to ${effectiveMaxResults} results`);
      } else if (queryAnalysis.estimatedCost === "medium") {
        effectiveMaxResults = Math.min(maxResults, 200);
      }

      // Escape and clean query for FTS5 safety
      let ftsQuery: string;

      // Handle special characters and potential injection attempts
      if (
        processedQuery.includes('"') ||
        processedQuery.includes("'") ||
        processedQuery.includes(";") ||
        processedQuery.includes("--")
      ) {
        // For potentially dangerous queries, use strict phrase search
        const escapedQuery = processedQuery.replace(/"/g, '""');
        ftsQuery = `"${escapedQuery}"`;
      } else if (processedQuery.includes(" ")) {
        // For multi-word queries, try word-based search first
        const words = processedQuery.split(/\s+/).filter((word: string) => word.length > 0);
        ftsQuery = words.join(" "); // Let FTS5 handle word matching
      } else {
        // For single words, use direct term search
        ftsQuery = processedQuery;
      }

      // Execute FTS5 search query with LIMIT to prevent expensive scans
      const cursor = this.state.storage.sql.exec<SearchResult>(
        "SELECT id, content, rank FROM documents WHERE documents MATCH ? ORDER BY rank LIMIT ?",
        ftsQuery,
        effectiveMaxResults
      );

      const results = cursor.toArray() as SearchResult[];

      // Log search metrics
      this.logger.info("Search completed", {
        processedQuery,
        resultCount: results.length,
        maxResults: effectiveMaxResults,
        estimatedCost: queryAnalysis.estimatedCost,
      });

      return results;
    } catch (error) {
      console.error(`Search error for query "${queryText}":`, error);

      // If search fails, try a simpler phrase search as fallback with limit
      try {
        const escapedQuery = queryText.replace(/"/g, '""');
        const cursor = this.state.storage.sql.exec<SearchResult>(
          "SELECT id, content, rank FROM documents WHERE documents MATCH ? ORDER BY rank LIMIT ?",
          `"${escapedQuery}"`,
          50 // Conservative limit for fallback
        );

        const fallbackResults = cursor.toArray() as SearchResult[];
        console.log(`Fallback search returned ${fallbackResults.length} results`);
        return fallbackResults;
      } catch (fallbackError) {
        console.error(`Fallback search also failed:`, fallbackError);
        return [];
      }
    }
  }

  /**
   * Syncs data to a specific replica using RPC
   */
  private async syncToReplica(replicaInfo: ReplicaInfo, documents: Document[]): Promise<void> {
    try {
      const stub = this.getReplicaStub(replicaInfo) as SearchIndexDOStub;
      if (!stub) return;

      this.logger.info(`Syncing to replica: ${replicaInfo.name || replicaInfo.id || "unknown"}`);

      const result = await stub.syncDocuments(documents);

      if (!result.success) {
        throw new Error(result.error || "Sync failed");
      }

      this.logger.info(`Successfully synced ${result.synced} documents to replica`);
    } catch (error) {
      this.logger.error(`Failed to sync to replica ${replicaInfo.name || replicaInfo.id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Searches across all cold storage DOs using RPC
   */
  private async searchColdStorage(queryText: string, maxResults: number = 100): Promise<SearchResult[]> {
    const coldStoragePrefix = this.config.coldStoragePrefix || "cold-storage";
    const currentIndex = this.config.currentColdStorageIndex || 0;
    const coldResults: SearchResult[] = [];

    this.logger.info(`Searching ${currentIndex} cold storage DOs for: "${queryText}" (max: ${maxResults})`);

    if (currentIndex === 0 || maxResults <= 0) {
      return coldResults;
    }

    // Distribute maxResults across cold storage DOs
    const resultsPerDO = Math.max(1, Math.ceil(maxResults / currentIndex));

    // Search all cold storage DOs in parallel using RPC
    const searchPromises: Promise<SearchResult[]>[] = [];

    for (let i = 0; i < currentIndex; i++) {
      const coldStorageName = `${coldStoragePrefix}-${i}`;
      const coldStorageId = this.env.COLD_STORAGE_DO.idFromName(coldStorageName);
      const coldStorageStub = this.env.COLD_STORAGE_DO.get(coldStorageId) as SearchIndexDOStub;

      searchPromises.push(
        coldStorageStub
          .searchDocuments({ query: queryText, maxResults: resultsPerDO })
          .then((results: SearchResult[]) => {
            this.logger.info(
              `Found ${results.length} results from cold storage ${coldStorageName} (requested: ${resultsPerDO})`
            );
            return results;
          })
          .catch((error: Error) => {
            this.logger.error(`Error searching cold storage ${coldStorageName}`, {
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          })
      );
    }

    // Wait for all searches to complete
    const allResults = await Promise.all(searchPromises);

    // Flatten and combine results
    for (const results of allResults) {
      coldResults.push(...results);
    }

    // Sort combined results by rank and apply final limit
    coldResults.sort((a, b) => a.rank - b.rank);

    // Apply final limit to prevent returning too many results
    if (coldResults.length > maxResults) {
      coldResults.splice(maxResults);
    }

    this.logger.info(`Found ${coldResults.length} total results from cold storage (requested: ${maxResults})`);
    return coldResults;
  }

  /**
   * Syncs recent data to all configured replicas using RPC
   */
  private async syncToReplicas(): Promise<void> {
    this.logger.info("Starting sync to replicas...");

    const lastSyncRowId = (await this.state.storage.get<number>("lastSyncRowId")) || 0;

    // Get new documents since last sync
    const cursor = this.state.storage.sql.exec<{ rowid: number; id: string; content: string }>(
      "SELECT rowid, id, content FROM documents WHERE rowid > ?",
      lastSyncRowId
    );

    const newDocs = cursor.toArray();

    if (!newDocs.length) {
      this.logger.info("No new documents to sync.");
      return;
    }

    this.logger.info(`Found ${newDocs.length} new documents to sync.`);
    const documents = newDocs.map(({ id, content }) => ({ id, content }));

    // Sync to all replicas using RPC
    const replicaPromises = (this.config.replicas || []).map((replicaInfo) =>
      this.syncToReplica(replicaInfo, documents)
    );

    await Promise.all(replicaPromises);

    // Update last synced row ID
    const maxRowId = Math.max(...newDocs.map((doc) => doc.rowid));
    await this.state.storage.put("lastSyncRowId", maxRowId);
    this.logger.info("Sync to replicas complete.");
  }

  /**
   * Gets a Durable Object stub for a replica with proper typing
   */
  private getReplicaStub(replicaInfo: ReplicaInfo): SearchIndexDOStub | null {
    try {
      if (replicaInfo.type === "region" && replicaInfo.name) {
        const id = this.env.REGION_REPLICA_DO.idFromName(replicaInfo.name);
        return this.env.REGION_REPLICA_DO.get(id, {
          locationHint: replicaInfo.name as DurableObjectLocationHint,
        }) as SearchIndexDOStub;
      } else if (replicaInfo.type === "local" && replicaInfo.id) {
        const id = this.env.LOCAL_REPLICA_DO.idFromString(replicaInfo.id);
        return this.env.LOCAL_REPLICA_DO.get(id) as SearchIndexDOStub;
      }

      this.logger.error("Invalid replica configuration", { replicaInfo });
      return null;
    } catch (error) {
      this.logger.error("Failed to create replica stub", {
        replicaInfo,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Purges old data when storage threshold is reached using RPC
   */
  private async purgeOldData(): Promise<void> {
    // Get current document count and actual database size
    const countCursor = this.state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
    const countResult = countCursor.toArray();
    const count = countResult[0]?.count || 0;
    const actualDatabaseSize = this.state.storage.sql.databaseSize;

    this.logger.info(
      `Current document count: ${count}, database size: ${actualDatabaseSize} bytes. Purge threshold: ${this.config.purgeThresholdDocs}`
    );

    // Check both document count and size thresholds
    const docCountThresholdReached = this.config.purgeThresholdDocs && count >= this.config.purgeThresholdDocs;
    const sizeThresholdReached = actualDatabaseSize > 9_000_000_000; // 9GB threshold (90% of 10GB limit)

    if (!docCountThresholdReached && !sizeThresholdReached) {
      return; // Below both thresholds
    }

    const reason = docCountThresholdReached ? "document count" : "database size";
    this.logger.info(`Purge triggered by ${reason} threshold`);

    const targetDocs = this.config.purgeTargetDocs || Math.floor(this.config.purgeThresholdDocs || count * 0.8);
    const numToPurge = count - targetDocs;

    this.logger.info(`Attempting to purge ${numToPurge} oldest documents.`);

    // Get oldest documents to purge
    const purgeCursor = this.state.storage.sql.exec<{ rowid: number; id: string; content: string }>(
      "SELECT rowid, id, content FROM documents ORDER BY rowid ASC LIMIT ?",
      numToPurge
    );

    const docsToPurge = purgeCursor.toArray();
    if (!docsToPurge.length) return;

    // Implement rolling cold storage using RPC
    let coldStorageIndex = this.config.currentColdStorageIndex || 0;
    let documentsRemaining = [...docsToPurge];
    const coldStoragePrefix = this.config.coldStoragePrefix || "cold-storage";
    const coldStorageThreshold = this.config.coldStorageThresholdDocs || this.config.purgeThresholdDocs || 100_000;

    try {
      while (documentsRemaining.length > 0) {
        const coldStorageName = `${coldStoragePrefix}-${coldStorageIndex}`;
        this.logger.info(`Checking cold storage DO: ${coldStorageName}`);

        // Get cold storage DO
        const coldStorageId = this.env.COLD_STORAGE_DO.idFromName(coldStorageName);
        const coldStorageStub = this.env.COLD_STORAGE_DO.get(coldStorageId) as SearchIndexDOStub;

        // Check current capacity of this cold storage DO using RPC
        let stats: DOStats;
        try {
          stats = await coldStorageStub.getStats();
        } catch (error) {
          // If the DO doesn't exist yet or fails, assume it's empty
          this.logger.info(`Cold storage ${coldStorageName} appears to be new or failed to respond`);
          stats = { count: 0, estimatedSize: 0 };
        }

        // Calculate how many documents we can fit
        const availableSpace = coldStorageThreshold - stats.count;

        if (availableSpace <= 0) {
          // This cold storage is full, move to next one
          this.logger.info(`Cold storage ${coldStorageName} is full (${stats.count} docs), moving to next`);
          coldStorageIndex++;
          continue;
        }

        // Take only what can fit
        const documentsToMove = documentsRemaining.slice(0, availableSpace);
        documentsRemaining = documentsRemaining.slice(availableSpace);

        this.logger.info(`Moving ${documentsToMove.length} documents to ${coldStorageName} (has ${stats.count} docs)`);

        // Move documents to this cold storage using RPC
        const documents = documentsToMove.map(({ id, content }) => ({ id, content }));
        let result: IndexResult;

        try {
          result = await coldStorageStub.indexDocuments(documents);
        } catch (error) {
          throw error;
        }

        if (!result.success) {
          throw new Error(`Failed to move documents to cold storage ${coldStorageName}: ${result.error}`);
        }

        // Mark as read-only if this is a new cold storage DO
        if (stats.count === 0) {
          this.logger.info(`Marking ${coldStorageName} as read-only`);
          try {
            await coldStorageStub.configureRPC({ isReadOnly: true });
          } catch (error) {
            throw error;
          }
        }

        this.logger.info(`Successfully moved ${result.indexed} documents to ${coldStorageName}`);

        // If we filled this cold storage to capacity, increment index for next time
        if (documentsToMove.length === availableSpace) {
          coldStorageIndex++;
        }
      }

      // Update the current cold storage index if it changed
      if (coldStorageIndex !== (this.config.currentColdStorageIndex || 0)) {
        await this.state.storage.put("currentColdStorageIndex", coldStorageIndex);
        this.config.currentColdStorageIndex = coldStorageIndex;
        this.logger.info(`Updated cold storage index to ${coldStorageIndex}`);
      }

      // Delete from SQLite after successful migration
      const lastDoc = docsToPurge[docsToPurge.length - 1];
      if (lastDoc) {
        this.state.storage.sql.exec(`DELETE FROM documents WHERE rowid <= ${lastDoc.rowid}`);
        this.logger.info(`Deleted ${docsToPurge.length} documents from hot storage`);
      }

      this.logger.info("Purge complete.");
    } catch (error) {
      this.logger.error("Failed to move documents to cold storage", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Logs current storage metrics for monitoring
   */
  private async logStorageMetrics(): Promise<void> {
    try {
      const countCursor = this.state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM documents");
      const countResult = countCursor.toArray();
      const count = countResult[0]?.count || 0;
      const actualSize = this.state.storage.sql.databaseSize;

      const storageMetrics: StorageMetrics = {
        database_size_bytes: actualSize,
        document_count: count,
        storage_utilization_percent: (actualSize / (10 * 1024 * 1024 * 1024)) * 100, // % of 10GB limit
        purge_triggered: false,
        cold_storage_count: this.config.currentColdStorageIndex || 0,
      };

      this.logger.storageMetrics(storageMetrics);
    } catch (error) {
      this.logger.error("Failed to log storage metrics", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
