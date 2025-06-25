# Security and Deployment Guide

This guide covers security best practices and deployment procedures for the Cloudflare Search-as-a-Service.

## 🔒 Security Features

### Authentication

#### Admin Token (Required for Production)
Administrative endpoints like `/configure` require Bearer token authentication in production environments.

**Setup:**
```bash
# Generate a secure token (use a password manager or secure random generator)
wrangler secret put ADMIN_TOKEN --env production
# Enter your secure admin token when prompted

# For staging
wrangler secret put ADMIN_TOKEN --env staging
```

**Usage:**
```bash
curl -X POST https://your-worker.workers.dev/configure \
  -H "Authorization: Bearer your-secure-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"alarmIntervalMs": 300000}'
```

#### API Key (Optional)
Search operations can optionally require an API key for additional security.

**Setup:**
```bash
# Optional: Require API keys for search operations
wrangler secret put API_KEY --env production
```

**Usage:**
```bash
curl https://your-worker.workers.dev/search?q=query \
  -H "X-API-Key: your-api-key"
```

### Environment-Based Security

- **Development**: Authentication is disabled for easier testing
- **Staging/Production**: Full authentication required

### Security Headers

All responses include security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy: default-src 'self'`

### Rate Limiting

Basic rate limiting is implemented with detailed request logging for monitoring.

## 🚀 Deployment Guide

### Prerequisites

1. **Cloudflare Account** with Workers plan
2. **Node.js** 20.x or later
3. **Wrangler CLI** installed and authenticated

### Step 1: Environment Setup

#### Development
```bash
npm install
npm run dev
```

#### Staging
```bash
# Deploy to staging
npm run deploy:staging
# or
wrangler deploy --env staging
```

#### Production
```bash
# Set production secrets
wrangler secret put ADMIN_TOKEN --env production
wrangler secret put API_KEY --env production  # Optional

# Deploy to production
npm run deploy:production
# or
wrangler deploy --env production
```

### Step 2: Configure Monitoring (Optional)

#### Datadog Integration
```bash
wrangler secret put DATADOG_API_KEY --env production
wrangler variable put DATADOG_URL --env production "https://http-intake.logs.datadoghq.com/v1/input"
```

#### Sentry Integration
```bash
wrangler secret put SENTRY_DSN --env production
wrangler variable put SENTRY_ENVIRONMENT --env production "production"
```

#### Custom Webhook
```bash
wrangler secret put MONITORING_WEBHOOK_URL --env production
wrangler secret put MONITORING_WEBHOOK_AUTH --env production
```

#### Sampling Configuration
```bash
# Adjust monitoring sampling rates (0.0 to 1.0)
wrangler variable put ERROR_SAMPLING_RATE --env production "1.0"
wrangler variable put METRICS_SAMPLING_RATE --env production "0.1"
wrangler variable put TRACE_SAMPLING_RATE --env production "0.05"
```

### Step 3: Initial Configuration

After deployment, configure the search system:

```bash
curl -X POST https://your-worker.workers.dev/configure \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "alarmIntervalMs": 300000,
    "purgeThresholdDocs": 1000000,
    "purgeTargetDocs": 800000,
    "replicas": [
      {"type": "region", "name": "europe"},
      {"type": "region", "name": "asia"}
    ]
  }'
```

### Step 4: Verify Deployment

```bash
# Test search (should return empty results initially)
curl https://your-worker.workers.dev/search?q=test

# Test indexing
curl -X POST https://your-worker.workers.dev/index \
  -H "Content-Type: application/json" \
  -d '{"id": "test-1", "content": "This is a test document"}'

# Verify search works
curl https://your-worker.workers.dev/search?q=test
```

## 🔧 Configuration Management

### Environment Variables

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `ADMIN_TOKEN` | Secret | Production | Admin token for `/configure` endpoint |
| `API_KEY` | Secret | Optional | API key for search operations |
| `DATADOG_API_KEY` | Secret | Optional | Datadog monitoring integration |
| `SENTRY_DSN` | Secret | Optional | Sentry error tracking |
| `MONITORING_WEBHOOK_URL` | Secret | Optional | Custom monitoring webhook |

### Wrangler Commands Reference

```bash
# List all secrets
wrangler secret list

# Delete a secret
wrangler secret delete SECRET_NAME

# List environment variables
wrangler var list

# Set environment variable
wrangler var put VAR_NAME value

# Deploy specific environment
wrangler deploy --env [staging|production]

# View logs
wrangler tail --env production

# Generate types
wrangler types
```

## 🛡️ Security Best Practices

### 1. Token Management
- Use strong, randomly generated tokens (32+ characters)
- Rotate tokens regularly
- Store tokens securely (use Cloudflare Secrets, not environment variables)
- Never commit tokens to version control

### 2. Access Control
- Limit `/configure` endpoint to trusted administrators only
- Consider IP allowlisting for admin operations
- Monitor admin endpoint usage

### 3. Monitoring
- Enable structured logging for security events
- Set up alerts for authentication failures
- Monitor for unusual traffic patterns
- Track rate limit violations

### 4. Network Security
- Use HTTPS only (enforced by Cloudflare Workers)
- Configure appropriate CORS policies
- Implement proper error handling (don't leak sensitive info)

### 5. Data Protection
- Validate all input data
- Sanitize search queries
- Implement proper rate limiting
- Monitor for injection attempts

## 🚨 Incident Response

### Authentication Failures
1. Check logs for patterns
2. Verify token configuration
3. Rotate tokens if compromised

### Performance Issues
1. Check monitoring dashboards
2. Review rate limiting logs
3. Scale replicas if needed

### Data Issues
1. Check indexing queue status
2. Verify document validation
3. Review cache invalidation

## 📊 Monitoring and Alerting

### Key Metrics to Monitor
- Authentication success/failure rates
- Search query latency
- Indexing throughput
- Error rates by endpoint
- Storage utilization

### Recommended Alerts
- Authentication failure spike
- High error rates (>5%)
- Queue backup (>1000 pending)
- Storage approaching limits (>80%)

### Log Analysis
All logs are structured JSON for easy analysis:
```json
{
  "@timestamp": "2024-01-01T12:00:00Z",
  "level": "info",
  "message": "search_operation",
  "service": "cf-search",
  "environment": "production",
  "operation": "search",
  "status": "success",
  "duration_ms": 45
}
```

## 🔄 Backup and Recovery

### Data Persistence
- Documents are stored in Durable Objects with automatic replication
- Cold storage provides archival and disaster recovery
- Configuration is stored in Durable Object state

### Recovery Procedures
1. **Index Corruption**: Recreate from cold storage
2. **Configuration Loss**: Restore via `/configure` endpoint
3. **Regional Outage**: Traffic automatically routes to healthy replicas

---

For additional security questions or to report vulnerabilities, please contact the security team. 