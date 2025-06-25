# Cloudflare Search Service - Testing Guide

This directory contains comprehensive tests for the Cloudflare search-as-a-service system using the latest Cloudflare Workers testing framework.

## Test Structure

```
tests/
├── README.md                     # This file
├── index.spec.ts                 # Basic worker tests
├── unit/                         # Unit tests
│   ├── validation.test.ts        # Document validation functions
│   └── config.test.ts            # Configuration builders and validation
├── integration/                  # Integration tests
│   ├── search-do.test.ts         # SearchIndexDO class tests
│   └── worker.test.ts            # Main worker endpoint tests
└── edge-cases/                   # Edge case and error scenario tests
    └── cold-storage.test.ts      # Cold storage edge cases
```

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Run Tests**
   ```bash
   # Run all tests
   npm test

   # Run tests in watch mode
   npm run test:watch

   # Run tests with coverage
   npm run test:coverage

   # Run tests with UI
   npm run test:ui
   ```

## Testing Framework

This test suite uses the latest Cloudflare Workers testing capabilities:

- **`cloudflare:test`** - Official Cloudflare testing utilities
- **Vitest with Worker Pool** - Real Cloudflare Workers runtime environment
- **Real Durable Objects** - Tests use actual DO instances, not mocks
- **Isolated Storage** - Each test gets isolated storage for reliable testing

### Key Features
- Tests run in real Cloudflare Workers runtime
- Automatic wrangler.toml configuration detection
- Isolated Durable Object storage per test
- No mocking required - tests real functionality

## Test Categories

### Unit Tests

**Validation Tests** (`tests/unit/validation.test.ts`)
- Document structure validation
- Type checking for id and content fields
- Array processing and error aggregation
- Edge cases: empty strings, null values, oversized content

**Configuration Tests** (`tests/unit/config.test.ts`)
- Environment-based configuration building
- Regional replica configuration
- Configuration validation
- Default value handling

### Integration Tests

**SearchIndexDO Tests** (`tests/integration/search-do.test.ts`)
- Document indexing workflow with real SQLite FTS5
- Full-text search functionality
- Configuration management
- Stats endpoint
- Sync functionality between DOs
- Error handling

**Worker Tests** (`tests/integration/worker.test.ts`)
- POST /index endpoint (document ingestion)
- GET /search endpoint (search queries)
- POST /configure endpoint (system configuration)
- Geographic routing with location hints
- Error responses and validation

### Edge Case Tests

**Cold Storage Tests** (`tests/edge-cases/cold-storage.test.ts`)
- Cold storage document operations
- Multi-DO search across cold storage
- Read-only cold storage enforcement
- Large batch processing
- Configuration edge cases

## Testing Approach

### Real Runtime Environment
```typescript
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

describe("Feature Tests", () => {
  it("should test real functionality", async () => {
    const ctx = createExecutionContext();
    
    // Use real env bindings from wrangler.toml
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    
    expect(response.status).toBe(200);
  });
});
```

### Real Durable Objects
```typescript
import { SearchIndexDO } from "@/durables";

// Get real DO instances
const getPrimaryDO = () => {
  const id = env.PRIMARY_INDEX_DO.idFromName("test-primary");
  return env.PRIMARY_INDEX_DO.get(id);
};

// Test real DO functionality
const response = await stub.fetch("http://do/search?q=javascript");
const results = await response.json();
```

## Test Data Management

**Test Documents**
Tests use realistic document structures:

```typescript
const docs = [
  { id: "doc1", content: "JavaScript programming tutorial" },
  { id: "doc2", content: "Python development guide" },
];
```

**Isolated Testing**
- Each test gets isolated Durable Object storage
- Tests don't interfere with each other
- Automatic cleanup between tests

## Important Testing Requirements

### 1. Always Consume Response Bodies
```typescript
// ❌ Wrong - response body not consumed
const response = await stub.fetch("/endpoint");

// ✅ Correct - always consume the body
const response = await stub.fetch("/endpoint");
await response.text(); // or .json(), even if not using the result
```

### 2. Use Callback Arguments in runInDurableObject
```typescript
// ❌ Wrong - using external stub
await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
  await stub.fetch("/endpoint"); // Don't use external stub
});

// ✅ Correct - using callback instance
await runInDurableObject(stub, async (instance: SearchIndexDO, state) => {
  await instance.fetch("/endpoint"); // Use callback instance
});
```

For detailed testing best practices, see [TESTING_BEST_PRACTICES.md](../TESTING_BEST_PRACTICES.md).

## Coverage Goals

The test suite aims for:
- **90%+ line coverage** across all source files
- **100% function coverage** for critical paths
- **Real-world scenario coverage** for production readiness

## Running Specific Test Suites

```bash
# Run only unit tests
npm test tests/unit

# Run only integration tests
npm test tests/integration

# Run only edge case tests
npm test tests/edge-cases

# Run specific test file
npm test tests/unit/validation.test.ts

# Run tests matching pattern
npm test -- --grep="cold storage"
```

## Test Scenarios Covered

### Document Processing
- ✅ Valid document indexing with real SQLite FTS5
- ✅ Invalid document rejection with validation
- ✅ Batch processing and upserts
- ✅ Content truncation handling
- ✅ Real search ranking and relevance

### Search Functionality
- ✅ Full-text search with SQLite FTS5
- ✅ Multi-term queries and phrase matching
- ✅ Empty result handling
- ✅ Cold storage search aggregation
- ✅ Geographic routing and location hints

### Cold Storage
- ✅ Document migration to cold storage DOs
- ✅ Cross-DO search functionality
- ✅ Read-only cold storage enforcement
- ✅ Stats tracking and capacity monitoring

### Configuration
- ✅ Environment-based configurations
- ✅ Regional replica setup
- ✅ Dynamic configuration updates
- ✅ Validation and error handling

### Error Handling
- ✅ Malformed JSON requests
- ✅ Invalid document formats
- ✅ Network failures between DOs
- ✅ SQL operation edge cases
- ✅ Configuration validation

### Real-World Scenarios
- ✅ Large document batches
- ✅ High document counts
- ✅ Concurrent operations
- ✅ Geographic distribution

## Writing New Tests

### Test Structure
```typescript
import { SearchIndexDO } from "@/durables";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Feature Name", () => {
  it("should handle normal case", async () => {
    const ctx = createExecutionContext();
    
    // Test real functionality
    const response = await env.PRIMARY_INDEX_DO
      .get(env.PRIMARY_INDEX_DO.idFromName("test"))
      .fetch("http://do/endpoint");
    
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
  });
});
```

### Best Practices
- Use descriptive test names
- Test real functionality, not mocks
- Use `waitOnExecutionContext()` for proper async handling
- Create isolated test data for each test
- Test both success and error scenarios
- **Always consume response bodies**
- **Use callback instances in runInDurableObject**

## Configuration

### Vitest Configuration
The test suite uses the latest vitest worker pool configuration:

```typescript
export default defineConfig({
  test: {
    pool: "workers",
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: true,
        wrangler: {
          configPath: "./wrangler.toml",
        },
      },
    },
  },
});
```

### Wrangler Configuration
Tests automatically use bindings from `wrangler.toml`:
- PRIMARY_INDEX_DO
- REGION_REPLICA_DO
- LOCAL_REPLICA_DO
- COLD_STORAGE_DO
- INDEX_QUEUE

## CI/CD Integration

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:coverage
```

## Performance Benefits

### Real Runtime Testing
- Tests actual performance characteristics
- Validates real SQLite FTS5 behavior
- Tests actual Durable Object limits
- Validates real network patterns

### Faster Test Execution
- No complex mocking setup
- Direct testing of functionality
- Parallel test execution with isolation
- Minimal test overhead

## Contributing

When adding new features:
1. Write tests that use real Cloudflare Workers functionality
2. Test both success and error scenarios
3. Use isolated test data
4. Ensure tests are independent and can run in any order
5. Follow the testing best practices in [TESTING_BEST_PRACTICES.md](../TESTING_BEST_PRACTICES.md)
6. Update this README for new test categories 