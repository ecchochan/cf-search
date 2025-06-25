# Configuration Guide

This guide explains how to configure the Cloudflare Search Service for different environments and use cases.

## Quick Start

```typescript
import { configs, CF_SEARCH_CONFIG } from './config';

// Use predefined configurations
const devConfig = configs.development();
const prodConfig = configs.production();

// Or customize the default config
const customConfig = configs.custom({
  alarmIntervalMs: 60_000, // 1 minute
  coldStoragePrefix: "archive", // Custom prefix for cold storage DOs
  replicas: [
    { type: "region", name: "weur" },
    { type: "region", name: "seas" }
  ]
});
```

## Time Constants

Use readable time constants instead of magic numbers:

```typescript
import { TIME } from './config';

const fiveMinutes = 5 * TIME.MINUTE;
const oneHour = TIME.HOUR;
const thirtySeconds = 30 * TIME.SECOND;
```

## Storage Configuration

The storage constants help estimate document capacity:

```typescript
import { STORAGE } from './config';

// Calculate documents for 5GB of storage
const docsFor5GB = 5 * STORAGE.DOCS_PER_GB; // 10,000,000 documents

// Safe storage limit (90% of 10GB)
const safeLimit = STORAGE.MAX_STORAGE_GB * STORAGE.SAFETY_MARGIN; // 9GB
```

## Cold Storage Configuration

The service automatically moves old documents to cold storage DOs when approaching storage limits:

- **Cold Storage Prefix**: Determines the naming pattern for cold storage DOs
- **Purge Threshold**: When to start moving documents to cold storage
- **Purge Target**: How many documents to keep in hot storage after purging
- **Cold Storage Threshold**: Maximum documents per cold storage DO (prevents cold storage from exceeding limits)

### Rolling Cold Storage

Cold storage DOs are filled to capacity before creating new ones:
- Each cold storage DO has a configurable capacity limit (`coldStorageThresholdDocs`)
- When a cold storage DO reaches capacity, the system automatically creates a new one
- This ensures efficient storage utilization and prevents creating many small DOs

Example flow:
1. `prod-cold-0` fills up to 10 million documents (5GB)
2. Next purge creates `prod-cold-1` for overflow
3. System tracks current index to know which cold storage to fill

### Cold Storage Search

Search can include cold storage by adding the `includeCold=true` parameter:

```bash
# Search only hot data
GET /search?q=keyword

# Search both hot and cold data
GET /search?q=keyword&includeCold=true
```

## Environment-Based Configuration

The config automatically adjusts based on the environment:

### Development
- Faster sync intervals (10 seconds)
- Lower document thresholds for testing
- Single local replica
- Cold storage prefix: `dev-cold`

### Staging
- Production-like settings
- Limited regional replicas (Europe & Asia)
- Standard sync intervals
- Cold storage prefix: `staging-cold`

### Production
- Full global replication (all regions)
- Optimized thresholds
- Production sync intervals
- Cold storage prefix: `prod-cold`

## Building Custom Replicas

```typescript
import { buildReplicas, CF_REGIONS } from './config';

// Select specific regions
const replicas = buildReplicas([
  CF_REGIONS.WESTERN_EUROPE,
  CF_REGIONS.SOUTH_EAST_ASIA,
  CF_REGIONS.NORTH_AMERICA_EAST
], 2); // Plus 2 local replicas

// Or build global replicas excluding a region
const globalReplicas = buildGlobalReplicas(CF_REGIONS.NORTH_AMERICA_WEST);
```

## Available Regions

The following Cloudflare regions are available:

- **Americas**: `wnam`, `enam`, `sam`
- **Europe**: `weur`, `eeur`
- **Asia Pacific**: `seas`, `neas`, `sas`, `oc`
- **Middle East & Africa**: `me`, `afr`

## Configuration Validation

Always validate custom configurations:

```typescript
import { validateConfig } from './config';

const myConfig = {
  alarmIntervalMs: 500, // Too low!
  purgeThresholdDocs: 1000,
  purgeTargetDocs: 2000, // Higher than threshold!
};

const { valid, errors } = validateConfig(myConfig);
if (!valid) {
  console.error('Configuration errors:', errors);
}
```

## Common Patterns

### High-Traffic Configuration
```typescript
const highTrafficConfig = configs.custom({
  alarmIntervalMs: 10 * TIME.SECOND,
  replicas: buildGlobalReplicas(),
  purgeThresholdDocs: 50_000,
  purgeTargetDocs: 40_000,
  coldStorageThresholdDocs: 10_000_000, // 10M docs per cold storage
  coldStoragePrefix: "high-traffic-archive",
});
```

### Regional Configuration
```typescript
const europeOnlyConfig = configs.custom({
  replicas: [
    { type: "region", name: CF_REGIONS.WESTERN_EUROPE },
    { type: "region", name: CF_REGIONS.EASTERN_EUROPE },
  ],
  coldStoragePrefix: "europe-cold",
});
```

### Test Configuration
```typescript
const testConfig = configs.custom({
  alarmIntervalMs: TIME.SECOND,
  purgeThresholdDocs: 100,
  purgeTargetDocs: 80,
  coldStorageThresholdDocs: 50, // Small cold storage for testing
  coldStoragePrefix: "test-cold",
  replicas: [],
});
```

### Cold Storage DO Configuration
Cold storage DOs are automatically configured as read-only:
```typescript
// When documents are moved to cold storage, the DO is marked as read-only
{ isReadOnly: true }
```

## Setting Environment

The configuration uses the `ENVIRONMENT` global variable:

```typescript
// In your worker's environment variables or wrangler.toml
globalThis.ENVIRONMENT = "production";

// The default config will automatically use production settings
import { CF_SEARCH_CONFIG } from './config';
```

## Understanding Cold Storage

Cold storage DOs are special instances that:
- Store archived documents from hot storage
- Remain searchable but are read-only
- Are global singletons (no replicas)
- Are automatically created when needed
- Are named sequentially: `{prefix}-0`, `{prefix}-1`, etc.

This approach keeps hot data fast while maintaining searchability of all historical data. 