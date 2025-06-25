# Architecture & Implementation Guide

Technical architecture and implementation details for the Cloudflare Search-as-a-Service system.

> **📋 For quick start and overview, see [README.md](./README.md)**  
> **🧪 For testing documentation, see [TESTING.md](./TESTING.md)**  
> **⚙️ For configuration details, see [Configuration Guide](./src/config-guide.md)**

## Architecture Overview

### Core Components

1. **Primary Durable Object (DO)**
   - Single global singleton located in Western North America (`wnam`)
   - Uses SQLite with FTS5 for full-text search
   - Handles all write operations
   - Manages data lifecycle (hot → cold storage)
   - Coordinates replication to regional replicas

2. **Regional Replica DOs**
   - Read-only replicas in all Cloudflare regions
   - Synced periodically from primary DO
   - Provides low-latency search for regional users
   - Supports spawning local replicas within same region

3. **Cold Storage DOs**
   - Read-only archives for old documents
   - Rolling storage system (fills to capacity before creating new)
   - Searchable when `includeCold=true` parameter is used
   - Automatic capacity management

4. **Queue-Based Ingestion**
   - Cloudflare Queue for resilient document indexing
   - Handles up to 1000 writes/second
   - Automatic retry on failures
   - Batch processing for efficiency

## Features Implemented

### Document Management
- **Indexing**: Queue-based resilient ingestion with validation
- **Upserts**: `INSERT OR REPLACE` for duplicate document IDs
- **Validation**: Comprehensive field validation with detailed errors
- **Truncation**: Automatic content truncation to 500 chars for storage efficiency

### Search Capabilities
- **Full-Text Search**: SQLite FTS5 with Porter stemming and Unicode support
- **Ranked Results**: Automatic relevance ranking
- **Cold Storage Search**: Optional inclusion of archived documents
- **Geographic Routing**: Automatic routing to nearest replica

### Data Lifecycle
- **Hot Storage**: Recent documents in primary and replicas
- **Automatic Purging**: Moves old documents when approaching 10GB limit
- **Rolling Cold Storage**: Fills cold storage DOs to capacity before creating new ones
- **Configurable Thresholds**: Environment-specific storage limits

### Configuration System
- **Environment-Based**: Development, staging, and production configs
- **Dynamic Updates**: Runtime configuration without redeploy
- **Validation**: Configuration parameter validation
- **Replica Management**: Flexible regional and local replica setup

### Monitoring & Stats
- **Document Count**: Real-time document statistics
- **Storage Tracking**: Real database size via `databaseSize` API
- **Read-Only Status**: Track cold storage DO status
- **Capacity Monitoring**: Prevent storage limit violations

## API Endpoints

### Worker Endpoints

```typescript
// Index documents
POST /index
Body: Document[] | Document
Response: { success: boolean, message?: string, error?: string }

// Search documents  
GET /search?q=<query>&includeCold=<true|false>
Response: SearchResult[]

// Configure system
POST /configure
Body: ConfigureRequest
Response: "Configured"
```

### Durable Object Internal Endpoints

```typescript
// Internal document indexing (from queue)
POST /internal-index

// Internal sync between DOs
POST /internal-sync

// Get statistics
GET /stats

// Configuration
POST /configure
```

## Configuration

### Environment Configurations

```typescript
// Development
{
  alarmIntervalMs: 10_000,          // 10 seconds
  purgeThresholdDocs: 1_000,
  purgeTargetDocs: 800,
  coldStorageThresholdDocs: 500,
  replicas: [{ type: "local", id: "dev-replica-1" }]
}

// Production
{
  alarmIntervalMs: 30_000,          // 30 seconds
  purgeThresholdDocs: 4_500_000,    // ~9GB
  purgeTargetDocs: 3_600_000,       // ~7.2GB
  coldStorageThresholdDocs: 4_500_000,
  replicas: [...all regions except primary]
}
```

### Storage Calculations

- **Document Size**: ~2KB average
- **Documents per GB**: ~500,000
- **Max Storage**: 10GB (Cloudflare limit)
- **Safety Margin**: 90% utilization for purge triggers

## Database Size Integration

### Accurate Size Tracking

**Before (Estimated):**
```typescript
// Old estimation approach
const estimatedSize = count * 500; // Rough estimate
```

**After (Real Database Size):**
```typescript
// New accurate approach using Cloudflare's databaseSize API
const actualSize = this.state.storage.sql.databaseSize;
```

### Enhanced Purge Logic

Dual threshold checking for more precise storage management:

```typescript
// Check both document count and actual database size
const docCountThresholdReached = count >= this.config.purgeThresholdDocs;
const sizeThresholdReached = actualDatabaseSize > 9_000_000_000; // 9GB (90% of 10GB)

if (!docCountThresholdReached && !sizeThresholdReached) {
  return; // Below both thresholds, no purge needed
}
```

**Benefits:**
- **Accurate Storage Monitoring** - Real size instead of estimates
- **Better Purge Triggers** - Prevents premature or delayed purging
- **Storage Limit Protection** - Precise monitoring of 10GB Cloudflare limits

## Security & Performance

### SQL Injection Prevention

All database operations use parameterized queries with proper argument chunking:

```typescript
// Secure parameterized approach
const CHUNK_SIZE = 15; // 15 docs × 2 params = 30 args (under 32 limit)
for (let i = 0; i < documents.length; i += CHUNK_SIZE) {
  const chunk = documents.slice(i, i + CHUNK_SIZE);
  await this.indexDocumentChunk(chunk, idType);
}
```

### Cloudflare Argument Limits

Compliant with Cloudflare's 32-argument limit per SQL operation:
- **Batch Size**: Maximum 15 documents per chunk (30 parameters)
- **Safety Margin**: 2 arguments below limit for stability
- **Performance**: Optimal balance between security and throughput

### FTS5 Optimizations

- **Integer IDs**: Uses `content_rowid=id` for FTS5 rowid optimization with `REPLACE INTO`
- **String IDs**: Uses `id UNINDEXED` with `DELETE + INSERT` approach  
- **Search Safety**: Query escaping and error handling for special characters

#### Configurable ID Types

The system supports both string and integer document IDs with optimized indexing strategies:

**Integer IDs (Optimized Schema):**
```sql
CREATE VIRTUAL TABLE documents USING fts5(
  content, 
  content_rowid=id, 
  tokenize = 'porter unicode61'
);
```

**String IDs (Fallback Schema):**
```sql
CREATE VIRTUAL TABLE documents USING fts5(
  id UNINDEXED, 
  content, 
  tokenize = 'porter unicode61'
);
```

#### Efficient Upsert Strategies

**Integer IDs - REPLACE Method (Optimal):**
```sql
REPLACE INTO documents(rowid, content) VALUES (?, ?);
```
- Single SQL operation for upserts
- Leverages FTS5's `content_rowid` optimization
- Significantly faster than DELETE+INSERT

**String IDs - DELETE+INSERT Method:**
```sql
DELETE FROM documents WHERE id = ?;
INSERT INTO documents (id, content) VALUES (?, ?);
```
- Two-step process for string ID compatibility
- Maintains data integrity for string-based systems
- Works around FTS5 limitations with string primary keys

#### Performance Benefits

1. **Faster Upserts**: Single `REPLACE` operation vs. `DELETE` + `INSERT` for integer IDs
2. **Better SQLite Performance**: Leverages rowid optimization  
3. **Reduced I/O**: Fewer SQL operations per document update
4. **Memory Efficiency**: FTS5 can optimize storage with integer rowids

#### Configuration

```typescript
// Configure DO for integer ID optimization
const config = {
  idType: "integer", // or "string" for compatibility
  // ... other config
};

await stub.fetch("/configure", {
  method: "POST",
  body: JSON.stringify(config)
});
```

## Known Limitations

### FTS5 Search Limitations

Some search scenarios have known limitations with SQLite FTS5:

```typescript
// Known FTS5 limitations documented in tests:
// - Emoji indexing: FTS5 doesn't index emojis well
// - Hyphenated terms: Parsing issues with "search-term" queries  
// - Large content: Search on truncated content can miss terms
// - Null bytes: SQLite limitations with null bytes in content
```

These are SQLite FTS5 engine limitations, not implementation bugs.

### Storage & Performance Constraints

- **10GB Limit**: Cloudflare's hard limit per Durable Object
- **32 SQL Arguments**: Maximum parameters per SQL operation
- **Geographic Latency**: Cross-region sync introduces eventual consistency
- **Cold Storage Access**: Additional latency when searching archived data

## Deployment

### Prerequisites

- Node.js 20.x
- Wrangler 3.x
- Cloudflare Workers account

### Commands

```bash
# Install dependencies
npm install

# Run comprehensive test suite
npm test

# Deploy to production
npm run deploy
```

### Wrangler Configuration

The service requires these bindings in `wrangler.toml`:

```toml
# Durable Objects
[[durable_objects.bindings]]
name = "PRIMARY_INDEX_DO"
class_name = "SearchIndexDO"

[[durable_objects.bindings]]
name = "REGION_REPLICA_DO" 
class_name = "SearchIndexDO"

[[durable_objects.bindings]]
name = "LOCAL_REPLICA_DO"
class_name = "SearchIndexDO"

[[durable_objects.bindings]]
name = "COLD_STORAGE_DO"
class_name = "SearchIndexDO"

# Queue
[[queues.producers]]
queue = "doc-ingestion-queue"
binding = "INDEX_QUEUE"

[[queues.consumers]]
queue = "doc-ingestion-queue"
```

## Performance Characteristics

### Write Performance
- **Queue Ingestion**: Up to 1000 docs/second
- **Batch Processing**: Configurable batch sizes
- **Async Processing**: Non-blocking document indexing

### Read Performance
- **Geographic Routing**: < 50ms latency to nearest replica
- **SQLite FTS5**: Millisecond search times
- **Cold Storage**: Additional latency when searching archives

### Storage Efficiency
- **Hot Storage**: ~4.5M documents per DO (9GB)
- **Cold Storage**: Same capacity per archive DO
- **Automatic Rotation**: Seamless hot → cold migration

## Monitoring & Operations

### Health Checks
- `/stats` endpoint on each DO
- Document count and real storage size
- Read-only status for cold storage

### Troubleshooting
- Check queue backlogs for indexing delays
- Monitor DO storage approaching limits via real `databaseSize`
- Verify replica sync status via stats

### Scaling Considerations
- Add more local replicas for read scaling
- Adjust purge thresholds for storage optimization
- Configure sync intervals based on data freshness needs

## Future Enhancements

### Potential Improvements
- **Search Features**: Fuzzy search, faceting, filters
- **Performance**: Caching layer, query optimization
- **Operations**: Metrics dashboard, alerting
- **Security**: Authentication, rate limiting

### Architecture Extensions
- **Multi-tenant**: Namespace isolation per customer
- **Analytics**: Search query analytics
- **Backup**: R2 integration for long-term archive