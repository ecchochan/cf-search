# Cloudflare Search Service - Cost Analysis

## Pricing Model
- **Requests**: $0.15/million 
- **Duration**: $12.50/million GB-s (128MB allocated per DO)
- **Rows scanned**: $0.001/million rows
- **Rows written**: $1.00/million rows (includes index writes)
- **SQL Stored data**: $0.20/GB-month

## 1. Cost Projections by Traffic Volume

### Small Scale (1M searches/month, 100K documents indexed)

#### Storage Costs
- **Document storage**: 100K docs × 500 chars × 2 bytes ≈ 100MB
- **FTS5 index overhead**: ~2-3x document size ≈ 300MB
- **Total storage**: ~400MB × $0.20/GB = **$0.08/month**

#### Write Costs
- **Document writes**: 100K documents
- **FTS5 index writes**: ~5-10 tokens per doc = 500K-1M index entries
- **Total row writes**: ~1.1M rows × $1.00/M = **$1.10/month**

#### Read Costs
- **Search requests**: 1M × $0.15/M = **$0.15/month**
- **Rows scanned**: 
  - Common terms (30%): 300K searches × 30K rows = 9B rows
  - Medium terms (50%): 500K searches × 1K rows = 500M rows
  - Rare terms (20%): 200K searches × 100 rows = 20M rows
  - Total: ~9.5B rows × $0.001/M = **$9.50/month**

#### Duration Costs
- **Primary DO**: Always active = 730 hours × 128MB = 93.44 GB-hours
- **Regional replicas**: 10 regions × 50% uptime = 467.2 GB-hours
- **Total**: 560.64 GB-hours × $12.50/M = **$7.01/month**

**Small Scale Total: ~$17.84/month**

### Medium Scale (10M searches/month, 1M documents indexed)

#### Storage Costs
- **Document storage**: 1M docs × 500 chars × 2 bytes ≈ 1GB
- **FTS5 index overhead**: ~3GB
- **Total storage**: ~4GB × $0.20/GB = **$0.80/month**

#### Write Costs
- **Document writes**: 1M documents
- **FTS5 index writes**: ~10M index entries
- **Cold storage moves**: ~100K docs/month = 200K operations
- **Total row writes**: ~11.2M rows × $1.00/M = **$11.20/month**

#### Read Costs
- **Search requests**: 10M × $0.15/M = **$1.50/month**
- **Rows scanned**: 
  - Common terms: 3M searches × 300K rows = 900B rows
  - Medium terms: 5M searches × 10K rows = 50B rows
  - Rare terms: 2M searches × 1K rows = 2B rows
  - Total: ~952B rows × $0.001/M = **$952/month**

#### Duration Costs
- **Primary DO**: Always active = 93.44 GB-hours
- **Regional replicas**: 10 regions × 80% uptime = 747.52 GB-hours
- **Cold storage DOs**: 2 DOs × 20% uptime = 37.38 GB-hours
- **Total**: 878.34 GB-hours × $12.50/M = **$10.98/month**

**Medium Scale Total: ~$976.48/month** (dominated by row scans)

### Large Scale (100M searches/month, 10M documents indexed)

#### Storage Costs
- **Hot storage**: 4.5M docs × 1KB ≈ 4.5GB
- **Cold storage**: 5.5M docs × 1KB ≈ 5.5GB
- **FTS5 indexes**: ~30GB total
- **Total storage**: ~40GB × $0.20/GB = **$8.00/month**

#### Write Costs
- **New documents**: 10M documents
- **FTS5 index writes**: ~100M index entries
- **Cold storage moves**: ~1M docs/month = 2M operations
- **Total row writes**: ~112M rows × $1.00/M = **$112/month**

#### Read Costs
- **Search requests**: 100M × $0.15/M = **$15/month**
- **Rows scanned**: 
  - Common terms: 30M searches × 3M rows = 90T rows
  - Medium terms: 50M searches × 100K rows = 5T rows
  - Rare terms: 20M searches × 10K rows = 200B rows
  - Total: ~95.2T rows × $0.001/M = **$95,200/month**

#### Duration Costs
- **Primary DO**: Always active = 93.44 GB-hours
- **Regional replicas**: 10 regions × 100% uptime = 934.4 GB-hours
- **Cold storage DOs**: 5 DOs × 50% uptime = 233.6 GB-hours
- **Total**: 1,261.44 GB-hours × $12.50/M = **$15.77/month**

**Large Scale Total: ~$95,350.77/month** (heavily dominated by row scans)

## 2. Cost Optimization Analysis

### Current Architecture Issues

1. **Row Scan Explosion**: Common search terms scan millions of rows
   - "memes" might match 30% of all documents
   - Each search scans the entire inverted index for that term
   - Cost grows linearly with document count

2. **Inefficient Index Design**: FTS5 indexes every token
   - Common words create massive inverted indexes
   - No way to exclude stop words at index time
   - Every document contributes to common term indexes

3. **Cold Storage Searches**: Double scanning
   - When `includeCold=true`, scans both hot and cold storage
   - Multiplies scan costs by number of cold storage DOs

## 3. Optimization Strategies

### Strategy 1: Remove Common Terms from Index

**Implementation:**
```typescript
// Pre-process documents before indexing
const STOP_WORDS = ["the", "and", "or", "but", "in", "on", "at", "to", "for"];
const COMMON_TERMS = ["meme", "memes", "cat", "cats", "funny", "video"];

function preprocessContent(content: string): string {
  const words = content.toLowerCase().split(/\s+/);
  return words
    .filter(word => !STOP_WORDS.includes(word) && !COMMON_TERMS.includes(word))
    .join(" ");
}
```

**Cost Impact:**
- Reduces index size by ~40-50%
- Reduces row scans for common queries by 90%+
- Medium scale: $976/month → ~$150/month
- Large scale: $95,350/month → ~$10,000/month

### Strategy 2: Implement Search Result Caching

**Architecture Change:**
```typescript
// Add caching layer for common queries
interface CachedSearch {
  query: string;
  results: SearchResult[];
  timestamp: number;
  ttl: number; // 5 minutes for common, 1 hour for rare
}

// Cache in KV or DO storage
const SEARCH_CACHE = new Map<string, CachedSearch>();
```

**Cost Impact:**
- Reduces duplicate scans by 70-80%
- Common queries served from cache
- Additional KV storage cost: ~$0.50/GB/month

### Strategy 3: Query-Based Routing

**Implementation:**
```typescript
// Route to specialized DOs based on query characteristics
function routeQuery(query: string): DurableObjectNamespace {
  const words = query.toLowerCase().split(/\s+/);
  
  // Common terms go to aggregated index
  if (words.some(w => COMMON_TERMS.includes(w))) {
    return env.COMMON_TERMS_DO;
  }
  
  // Rare terms use full index
  return env.PRIMARY_INDEX_DO;
}
```

**Benefits:**
- Separate indexes for common vs rare terms
- Smaller scans for frequent queries
- Better cache locality

### Strategy 4: Implement Pagination Limits

**Implementation:**
```typescript
// Limit maximum results returned
const MAX_RESULTS = 100;
const MAX_SCAN_ROWS = 10000;

// Use SQL LIMIT to cap scanning
const query = `
  SELECT id, content, rank
  FROM documents 
  WHERE content MATCH ?
  ORDER BY rank
  LIMIT ${MAX_RESULTS}
`;
```

**Cost Impact:**
- Caps worst-case scan costs
- Improves response times
- Reduces duration costs

## Recommendations

### Immediate Actions (Quick Wins)
1. **Implement stop word filtering** - 40% cost reduction
2. **Add result caching** - 70% reduction for common queries
3. **Set scan limits** - Cap worst-case costs

### Medium-term Changes
1. **Re-index existing documents** without common terms
2. **Implement tiered search** (hot → warm → cold)
3. **Add query complexity analyzer**

### Long-term Architecture Changes
1. **Separate indexes** for common vs rare terms
2. **Pre-aggregated results** for top queries
3. **Consider external search service** for high-volume scenarios

## Cost Comparison Summary

| Scale | Current Cost | Optimized Cost | Savings |
|-------|--------------|----------------|---------|
| Small (1M searches) | $17.84/mo | $12/mo | 33% |
| Medium (10M searches) | $976/mo | $150/mo | 85% |
| Large (100M searches) | $95,350/mo | $10,000/mo | 89% |

## Conclusion

The current architecture is **not cost-optimized** for high-volume searches of common terms. The dominant cost factor is row scanning, which grows exponentially with both document count and search volume.

**Key Recommendations:**
1. **Yes, re-index documents** to exclude common terms
2. **Implement caching** for frequent queries
3. **Set hard limits** on scan operations
4. **Consider hybrid approach** for very high volumes (>10M searches/month)

The optimizations could reduce costs by 85-90% while maintaining search quality for most use cases. 