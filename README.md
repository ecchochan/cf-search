# Cloudflare Search-as-a-Service

A distributed, globally-scalable full-text search service built on Cloudflare Workers with Durable Objects, SQLite FTS5, and intelligent geographic routing.

## Quick Start

```bash
# Install dependencies
npm install

# Run tests
npm test

# Deploy to production
npm run deploy
```

## API Usage

```typescript
// Index documents
POST /index
Body: Document[] | Document

// Search documents  
GET /search?q=<query>&includeCold=<true|false>

// Configure system
POST /configure
Body: ConfigureRequest
```

## Documentation

- **[📋 Architecture & Implementation](./blueprint.md)** - Complete system design, features, and deployment guide
- **[🧪 Testing Guide](./TESTING.md)** - Comprehensive testing documentation, best practices, and robustness testing
- **[⚙️ Configuration Guide](./src/config-guide.md)** - Environment setup, storage configuration, and regional deployment
- **[💰 Cost Analysis](./COST_ANALYSIS.md)** - Detailed pricing breakdown and optimization strategies

## Key Features

- **Global Distribution** - Regional replicas for low-latency search worldwide
- **Full-Text Search** - SQLite FTS5 with Porter stemming and Unicode support  
- **Auto-Scaling Storage** - Hot/cold storage with automatic lifecycle management
- **Queue-Based Ingestion** - Resilient document indexing up to 1000 docs/second
- **Production Ready** - Comprehensive test suite with 120+ test cases

## Performance

- **Search Latency**: < 50ms to nearest replica
- **Storage Capacity**: ~4.5M documents per DO (9GB)
- **Write Performance**: Up to 1000 docs/second via queue
- **Global Reach**: All Cloudflare regions supported

---

Built for production scale with comprehensive testing, monitoring, and operational excellence. 