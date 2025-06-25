/**
 * This is the main Cloudflare Worker entrypoint.
 * It handles incoming HTTP requests and messages from the Queue.
 *
 * Responsibilities:
 * 1.  /index - Accepts new documents and sends them to a Queue for reliable ingestion.
 * 2.  /search - Intelligently routes search queries to the geographically closest read-replica DO.
 * 3.  /configure - Allows administrative tasks like setting up replication.
 * 4.  queue() - Consumes batches of documents from the Queue and sends them to the primary DO for indexing using RPC.
 */

import { PRIMARY_DO, SEARCH_CONFIG } from "./config";
import { analyzeQuery, preprocessQuery } from "./content-processor";
import { getCachedResults, invalidateCache, setCachedResults } from "./search-cache";
import {
  addSecurityHeaders,
  checkRateLimit,
  createSecurityErrorResponse,
  validateAdminAuth,
  validateApiKey,
} from "./security";
import type {
  ApiResponse,
  ConfigureRequest,
  Document,
  Env,
  SearchIndexDOStub,
  SearchResult,
  ValidationError,
} from "./types";

export * from "./durables";

// Helper function to validate documents permissively (accepts both string and integer IDs)
function validateDocumentsPermissive(data: unknown): {
  valid: boolean;
  errors: ValidationError[];
  data: Document[] | undefined;
} {
  let dataArray: unknown[];

  if (!Array.isArray(data)) {
    dataArray = [data];
  } else {
    dataArray = data;
  }

  const errors: ValidationError[] = [];
  const validDocuments: Document[] = [];

  dataArray.forEach((doc: unknown, index: number) => {
    if (!doc || typeof doc !== "object") {
      errors.push({
        field: `documents[${index}]`,
        message: "Document must be an object",
        value: doc,
      });
      return;
    }

    // Type assertion after validation
    const docObj = doc as Record<string, unknown>;

    // Accept both string and integer IDs at worker level
    const hasValidId =
      (typeof docObj.id === "string" && docObj.id.length > 0 && docObj.id.length <= 255) ||
      (typeof docObj.id === "number" && Number.isInteger(docObj.id) && docObj.id >= 0);

    if (!hasValidId) {
      errors.push({
        field: `documents[${index}].id`,
        message: "ID must be a non-empty string (max 255 chars) or non-negative integer",
        value: docObj.id,
      });
    }

    if (typeof docObj.content !== "string" || docObj.content.length === 0) {
      errors.push({
        field: `documents[${index}].content`,
        message: "Content must be a non-empty string",
        value: docObj.content,
      });
    }

    if (hasValidId && typeof docObj.content === "string" && docObj.content.length > 0) {
      validDocuments.push(docObj as Document);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    data: validDocuments.length > 0 ? validDocuments : undefined,
  };
}

// Helper function to perform search with geo-routing
async function performSearch(
  env: Env,
  query: string,
  colo: string | undefined,
  includeCold: boolean,
  maxResults: number
): Promise<SearchResult[]> {
  console.log(`Search request received in: ${colo || "unknown"}`);

  // Get a DO stub for a replica in the same region as the request.
  // The `locationHint` is the key to routing to a nearby DO instance.
  const id = env.REGION_REPLICA_DO.idFromName(colo || "auto");
  const stub = env.REGION_REPLICA_DO.get(id, {
    locationHint: colo as DurableObjectLocationHint,
  }) as SearchIndexDOStub;

  // Use RPC method for search with HTTP fallback for tests
  let results: SearchResult[];
  try {
    results = await stub.searchDocuments({
      query,
      includeCold,
      maxResults,
    });
  } catch (error) {
    // Fallback to HTTP for test environment
    if (error instanceof TypeError && error.message.includes("subclass of")) {
      console.log("RPC search failed, falling back to HTTP");
      const httpResponse = await stub.fetch(
        `http://do/search?q=${encodeURIComponent(query)}&includeCold=${includeCold}&maxResults=${maxResults}`
      );

      if (httpResponse.ok) {
        results = (await httpResponse.json()) as SearchResult[];
      } else {
        console.warn(`HTTP search fallback failed: ${httpResponse.status} ${httpResponse.statusText}`);
        // Return empty results instead of throwing
        results = [];
      }
    } else {
      console.error("Search error:", error);
      // Return empty results instead of throwing
      results = [];
    }
  }

  return results;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // The fixed name for our singleton primary DO.
    if (request.method === "POST" && path === "/index") {
      // --- WRITE PATH: Ingest a new document ---
      // For resilience, we don't write directly to the DO. We send it to a queue.
      // The queue consumer will handle the actual writing using RPC.
      try {
        const rawData = await request.json();

        // Use permissive validation that accepts both string and integer IDs
        const validation = validateDocumentsPermissive(Array.isArray(rawData) ? rawData : [rawData]);

        if (!validation.valid) {
          const response: ApiResponse = {
            success: false,
            error: "Invalid document format",
          };

          return addSecurityHeaders(
            new Response(
              JSON.stringify({
                ...response,
                validationErrors: validation.errors,
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            )
          );
        }

        if (!validation.data || validation.data.length === 0) {
          const response: ApiResponse = {
            success: false,
            error: "No valid documents to index",
          };

          return addSecurityHeaders(
            new Response(JSON.stringify(response), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            })
          );
        }

        // Send validated documents to queue
        await env.INDEX_QUEUE.send(validation.data);

        const response: ApiResponse = {
          success: true,
          message: `${validation.data.length} documents queued for indexing.`,
        };

        return addSecurityHeaders(
          new Response(JSON.stringify(response), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          })
        );
      } catch (error) {
        const response: ApiResponse = {
          success: false,
          error: "Invalid JSON body or processing error.",
        };

        return addSecurityHeaders(
          new Response(JSON.stringify(response), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    }

    if (request.method === "GET" && path === "/search") {
      // --- READ PATH: Perform a search ---
      // This is where geo-routing happens to minimize latency.
      const query = url.searchParams.get("q");
      const includeCold = url.searchParams.get("includeCold") === "true";

      if (!query) {
        return addSecurityHeaders(
          new Response(
            JSON.stringify({
              success: false,
              error: "Bad request: missing query parameter",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }

      // Check query length limits
      if (query.length < SEARCH_CONFIG.MIN_QUERY_LENGTH) {
        return addSecurityHeaders(
          new Response(
            JSON.stringify({
              error: "Query too short",
              details: `Minimum query length is ${SEARCH_CONFIG.MIN_QUERY_LENGTH} characters`,
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }

      if (query.length > SEARCH_CONFIG.MAX_QUERY_LENGTH) {
        return addSecurityHeaders(
          new Response(
            JSON.stringify({
              error: "Query too long",
              details: `Maximum query length is ${SEARCH_CONFIG.MAX_QUERY_LENGTH} characters`,
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }

      // Parse maxResults parameter with limits
      const maxResultsParam = url.searchParams.get("maxResults");
      let maxResults: number = SEARCH_CONFIG.DEFAULT_PAGE_SIZE;

      if (maxResultsParam) {
        const parsed = parseInt(maxResultsParam, 10);
        if (isNaN(parsed) || parsed < 1) {
          return addSecurityHeaders(
            new Response(
              JSON.stringify({
                error: "Invalid maxResults",
                details: "maxResults must be a positive integer",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            )
          );
        }
        maxResults = Math.min(parsed, SEARCH_CONFIG.MAX_RESULTS_PER_PAGE);
      }

      // Check for metadata parameter
      const includeMetadata = url.searchParams.get("includeMetadata") === "true";

      try {
        // Check rate limiting for search operations
        const rateLimitCheck = checkRateLimit(request);
        if (!rateLimitCheck.isAllowed) {
          return createSecurityErrorResponse(rateLimitCheck.error || "Rate limit exceeded", 429);
        }

        // Optional API key validation for search (only if API_KEY is configured)
        const apiKeyResult = validateApiKey(request, env);
        if (!apiKeyResult.isValid) {
          return createSecurityErrorResponse(apiKeyResult.error || "API key validation failed", 401);
        }

        // Preprocess query to remove stop words (but keep common terms for search)
        const processedQuery = preprocessQuery(query);

        // If preprocessing removed everything, the query was all stop words
        if (!processedQuery) {
          return addSecurityHeaders(
            new Response(
              JSON.stringify({
                error: "Query too generic",
                details: "Query contained only stop words",
                suggestion: "Please include more specific search terms",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            )
          );
        }

        // Enhanced query cost analysis
        const queryAnalysis = analyzeQuery(processedQuery);

        // Reject extremely expensive queries at the worker level
        if (queryAnalysis.isTooCommon) {
          return addSecurityHeaders(
            new Response(
              JSON.stringify({
                error: "Query too expensive",
                details:
                  queryAnalysis.reason || "Query contains too many common terms that would be expensive to process",
                suggestion: "Please use more specific search terms to narrow your search",
                queryAnalysis: {
                  commonTermsRatio: queryAnalysis.commonTermsRatio,
                  estimatedCost: queryAnalysis.estimatedCost,
                },
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            )
          );
        }

        // Adjust maxResults based on query cost to optimize performance
        if (queryAnalysis.estimatedCost === "high") {
          maxResults = Math.min(maxResults, SEARCH_CONFIG.OPTIMIZATION.HIGH_COST_LIMIT);
          console.warn(`Limiting high-cost query to ${maxResults} results: "${query}"`);
        } else if (queryAnalysis.estimatedCost === "medium") {
          maxResults = Math.min(maxResults, SEARCH_CONFIG.OPTIMIZATION.MEDIUM_COST_LIMIT);
        }

        // Check cache first if KV is available
        let results: SearchResult[] | null = null;

        if (env.SEARCH_CACHE) {
          results = await getCachedResults(env.SEARCH_CACHE, processedQuery, includeCold);
        }

        // If not in cache, perform actual search with optimized parameters
        if (!results) {
          results = await performSearch(
            env,
            processedQuery,
            request.cf?.colo as string | undefined,
            includeCold,
            maxResults
          );

          // Cache the results for future requests
          if (env.SEARCH_CACHE && results.length > 0) {
            // Use the original query analysis to determine cache TTL
            await setCachedResults(
              env.SEARCH_CACHE,
              processedQuery,
              includeCold,
              results,
              queryAnalysis.commonTermsRatio
            );
          }
        } else {
          // Apply maxResults limit to cached results as well
          if (results.length > maxResults) {
            results = results.slice(0, maxResults);
          }
        }

        // Return response based on metadata preference
        if (includeMetadata) {
          // Include metadata about query optimization for advanced users
          const response = {
            results,
            metadata: {
              query: processedQuery,
              originalQuery: query,
              estimatedCost: queryAnalysis.estimatedCost,
              resultCount: results.length,
              maxResults: maxResults,
              fromCache: !!results && env.SEARCH_CACHE,
              queryOptimizations: {
                stopWordsRemoved: query !== processedQuery,
                resultLimitApplied: results.length === maxResults,
              },
            },
          };

          return addSecurityHeaders(
            new Response(JSON.stringify(response), {
              headers: { "Content-Type": "application/json" },
            })
          );
        } else {
          // Backward compatible: return just results array
          return addSecurityHeaders(
            new Response(JSON.stringify(results), {
              headers: { "Content-Type": "application/json" },
            })
          );
        }
      } catch (error) {
        console.error("Search error:", error);
        return addSecurityHeaders(
          new Response(
            JSON.stringify({
              error: "Search failed",
              details: "An internal error occurred while processing your search",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }
    }

    if (request.method === "POST" && path === "/configure") {
      // --- ADMIN PATH: Configure the system ---
      // This endpoint configures the primary DO. For example, telling it which regions to replicate to.
      // Protected by authentication in production environments.

      // Check rate limiting
      const rateLimitCheck = checkRateLimit(request);
      if (!rateLimitCheck.isAllowed) {
        return createSecurityErrorResponse(rateLimitCheck.error || "Rate limit exceeded", 429);
      }

      // Validate admin authentication
      const authResult = validateAdminAuth(request, env);
      if (!authResult.isValid) {
        return createSecurityErrorResponse(authResult.error || "Authentication failed", 401);
      }

      try {
        const config = (await request.json()) as ConfigureRequest;

        // To configure the primary DO, we must get its stub. We use `idFromName` to get the singleton.
        // We place it in 'wnam' (Western North America) by convention.
        const id = env.PRIMARY_INDEX_DO.idFromName(PRIMARY_DO.NAME);
        const stub = env.PRIMARY_INDEX_DO.get(id, { locationHint: PRIMARY_DO.LOCATION }) as SearchIndexDOStub;

        // Use native RPC method instead of HTTP fetch
        await stub.configureRPC(config);

        const response: ApiResponse = {
          success: true,
          message: "Configuration updated successfully",
        };

        return addSecurityHeaders(
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      } catch (error) {
        const response: ApiResponse = {
          success: false,
          error: "Invalid JSON body or processing error.",
        };

        return addSecurityHeaders(
          new Response(JSON.stringify(response), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    }

    return addSecurityHeaders(new Response("Not Found", { status: 404 }));
  },

  /**
   * Queue consumer using modern RPC pattern.
   * This function is triggered by Cloudflare when messages are available in the queue.
   * @param batch - A batch of messages from the queue.
   * @param env - The environment bindings.
   * @param ctx - The execution context.
   */
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Queue consumer invoked with ${batch.messages.length} messages.`);

    // Get the singleton primary DO stub with proper typing
    const id = env.PRIMARY_INDEX_DO.idFromName(PRIMARY_DO.NAME);
    const stub = env.PRIMARY_INDEX_DO.get(id, { locationHint: PRIMARY_DO.LOCATION }) as SearchIndexDOStub;

    // Collect all documents from the batch (permissive validation already done)
    const allDocuments: Document[] = [];
    for (const message of batch.messages) {
      const docs = Array.isArray(message.body) ? message.body : [message.body];
      allDocuments.push(...docs);
    }

    if (allDocuments.length === 0) {
      console.log("No documents to process in batch");
      batch.ackAll();
      return;
    }

    try {
      // Use native RPC method instead of HTTP fetch
      const result = await stub.indexDocuments(allDocuments);

      if (!result.success) {
        throw new Error(`Failed to index documents: ${result.error || "Unknown error"}`);
      }

      console.log(`Successfully processed batch: indexed ${result.indexed} documents`);

      // Invalidate search cache after successful indexing
      if (env.SEARCH_CACHE && result.indexed > 0) {
        await invalidateCache(env.SEARCH_CACHE);
        console.log("Search cache invalidated after indexing");
      }

      // Acknowledge all messages in the batch.
      batch.ackAll();
    } catch (error) {
      console.error("Error processing queue batch:", error);
      // Retry all messages in the batch if something went wrong.
      batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;
