# Search Optimization & Cost Control Strategy

## Guiding Principles

1.  **Cost Predictability**: No single user query should be able to generate unbounded costs.
2.  **Performance**: Common queries should be fast and cheap; rare queries can be slower and more expensive.
3.  **Abuse Resistance**: The system must be resilient to malicious or poorly formed queries.
4.  **Progressive Complexity**: Start with simple, high-impact optimizations and add complexity only as needed.

## The Core Problem: Unpredictable Query Cost

The fundamental issue is that the cost of a search query is determined by the term's frequency in the dataset.

-   **Rare Term (`"zeldovich-pancake"`)**: Scans very few rows. **Cost: ~$0.0001**
-   **Common Term (`"cat"`)**: Scans millions of rows. **Cost: ~$1.00+ per query**

A malicious actor could spam the single most common term, leading to massive, unexpected costs.

## Multi-Layered Optimization Strategy

We will implement a series of defenses, starting with the highest-impact, lowest-effort changes.

### Layer 1: Index-Time Content Pre-processing (Highest Impact)

**Problem**: The FTS5 index is bloated with common, low-value words ("the", "a", "and") and domain-specific common terms ("meme", "cat").

**Solution**: Filter these words out *before* indexing a document. This shrinks the index, making all subsequent operations cheaper and faster.

**Implementation**:
1.  Create a `preprocessContent` function.
2.  Define lists of generic "stop words" and application-specific "common terms".
3.  Modify the `indexDocuments` method to apply this filter to all incoming content.

**Cost Impact**: Reduces index size and row scans for common queries by **40-90%**. This is our biggest lever for cost savings.

---

### Layer 2: Query-Time Analysis & Caching (Smart Defense)

**Problem**: Even with a smaller index, costly queries are still possible. We should prevent them from running repeatedly.

**Solution**:
1.  **Query Complexity Analysis**: Before executing a search, analyze it. If it consists solely of common terms or is otherwise deemed "too broad," reject it with a `400 Bad Request`.
2.  **Result Caching**: For expensive queries that *are* allowed to run, cache the results in Cloudflare KV. Subsequent identical queries will hit the cache, costing virtually nothing.

**Implementation**:
1.  Create a `getQueryCost` function that scores a query based on its terms.
2.  In the `/search` endpoint, check the query's cost before proceeding.
3.  Integrate a KV-based caching layer with a Time-to-Live (TTL), e.g., 5 minutes for common queries.

---

### Layer 3: Hard Limits & Failsafes (The Safety Net)

**Problem**: A clever attacker might still find a way to construct an unexpectedly expensive query. We need a hard stop.

**Solution**:
1.  **Scan Limiting**: Use the SQL `LIMIT` clause to cap the number of results returned. This doesn't directly limit rows scanned but provides some control.
2.  **Pagination Enforcement**: Enforce strict pagination (`page`, `pageSize`) to prevent users from requesting thousands of results at once.
3.  **Rate Limiting**: Apply worker-level rate limiting based on IP address to prevent brute-force spam.

**Implementation**:
1.  Update all search SQL queries to include a `LIMIT` clause.
2.  Add pagination parameters and validation to the `/search` endpoint.
3.  Configure rate limiting in `wrangler.toml` or the Cloudflare dashboard.

## Step-by-Step Implementation Plan

1.  ✅ **(Current Step)** Implement **Layer 1: Index-Time Content Pre-processing**. This will provide the most significant and immediate cost savings.
2.  Implement **Layer 2: Query Complexity Analysis & Caching**.
3.  Implement **Layer 3: Hard Limits & Failsafes**.
4.  Re-evaluate costs and performance.

By following this layered approach, we will systematically de-risk the service and gain control over our operational costs. 