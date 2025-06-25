# 🔍 Comprehensive Monitoring Setup for Cloudflare Search Service

## Overview

This guide provides complete monitoring setup for your Cloudflare search service using Datadog. With proper monitoring, you'll have full visibility into performance, errors, storage usage, and business metrics.

## 🚀 **Quick Setup Summary**

1. **Configure Cloudflare → Datadog log shipping**
2. **Deploy enhanced search service with structured logging**
3. **Set up Datadog log parsing and metrics**
4. **Create dashboards and alerts**
5. **Configure SLOs for production**

## 📋 **Step-by-Step Setup**

### 1. **Cloudflare Log Shipping Configuration**

#### A. Enable Logpush to Datadog

```bash
# Using Cloudflare API
curl -X POST "https://api.cloudflare.com/client/v4/zones/ZONE_ID/logpush/jobs" \
  -H "X-Auth-Email: your-email@example.com" \
  -H "X-Auth-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cf-search-datadog-logs",
    "destination_conf": "datadog://intake.logs.datadoghq.com:443?dd-api-key=YOUR_DATADOG_API_KEY&service=cf-search&source=cloudflare",
    "dataset": "workers_trace_events",
    "enabled": true,
    "logpull_options": "fields=Event,EventTimestampMs,Outcome,ScriptName,ScriptTags,Logs,Exceptions&timestamps=rfc3339"
  }'
```

#### B. Configure Log Fields

Include these essential fields for comprehensive monitoring:

```json
{
  "fields": [
    "Event",
    "EventTimestampMs", 
    "Outcome",
    "ScriptName",
    "ScriptTags",
    "Logs",
    "Exceptions",
    "CPUTime",
    "DurableObjectId",
    "RequestHeaders",
    "ResponseHeaders"
  ]
}
```

#### C. Wrangler Configuration

Add to your `wrangler.toml`:

```toml
[env.production.logpush]
enabled = true
destination = "datadog"
fields = [
  "Event",
  "EventTimestampMs",
  "Outcome", 
  "ScriptName",
  "Logs",
  "Exceptions",
  "DurableObjectId"
]
```

### 2. **Datadog Log Processing Setup**

#### A. Create Log Processing Pipeline

In Datadog Logs → Configuration → Pipelines:

```yaml
# Pipeline: cf-search-processing
source: cloudflare
service: cf-search

processors:
  # 1. JSON Parser for Cloudflare logs
  - type: json-parser
    name: cloudflare-json-parser
    sources: ["message"]
    target: "cloudflare"
    
  # 2. Extract nested log data
  - type: json-parser  
    name: search-logs-parser
    sources: ["cloudflare.Logs.0.message"]
    target: "search_log"
    
  # 3. Date remapper
  - type: date-remapper
    name: timestamp-remapper
    sources: ["cloudflare.EventTimestampMs"]
    
  # 4. Status remapper
  - type: status-remapper
    name: status-remapper
    sources: ["search_log.level"]
    
  # 5. Service remapper
  - type: service-remapper
    name: service-remapper
    sources: ["search_log.service"]
```

#### B. Create Custom Metrics

Navigate to Logs → Generate Metrics:

```yaml
# Search Latency Metric
- name: cf_search.search.latency
  query: "service:cf-search operation:search"
  measure: "@search_log.duration_ms"
  group_by: ["@search_log.status", "@search_log.doType"]

# Index Latency Metric  
- name: cf_search.index.latency
  query: "service:cf-search operation:index"
  measure: "@search_log.duration_ms"
  group_by: ["@search_log.status", "@search_log.doType"]

# Error Count Metric
- name: cf_search.errors.count
  query: "service:cf-search status:error"
  group_by: ["@search_log.error_type", "@search_log.operation"]

# Storage Size Metric
- name: cf_search.storage.size_bytes
  query: "service:cf-search metrics_type:storage_status"
  measure: "@search_log.database_size_bytes"
  group_by: ["@search_log.doType", "@search_log.doId"]
```

### 3. **Dashboard Configuration**

#### A. Import Dashboard JSON

Create dashboard using the Datadog API:

```bash
curl -X POST "https://api.datadoghq.com/api/v1/dashboard" \
  -H "Content-Type: application/json" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  -d @cf-search-dashboard.json
```

#### B. Key Dashboard Widgets

**Performance Monitoring:**
- Search latency percentiles (P50, P95, P99)
- Index operation latency
- Operations per second
- Success rate percentage

**Error Tracking:**
- Error rate by operation type
- Top error types and frequencies
- Error trends over time

**Storage Monitoring:**
- Storage utilization percentage
- Document count by DO type
- Database size growth trends
- Cold storage utilization

**Business Metrics:**
- Search results distribution
- Popular query patterns
- User engagement metrics

### 4. **Alert Configuration**

#### A. Critical Production Alerts

```yaml
# High Search Latency Alert
search_latency_high:
  name: "CF Search - High Latency"
  type: metric alert
  query: "avg(last_5m):p95:cf_search.search.latency{*} > 1000"
  message: |
    Search latency P95 is above 1 second.
    @slack-alerts-channel
    
    Runbook: https://docs.company.com/runbooks/cf-search-latency

# Storage Critical Alert  
storage_critical:
  name: "CF Search - Storage Critical"
  type: metric alert
  query: "avg(last_1m):cf_search.storage.utilization_percent{*} > 95"
  message: |
    🚨 CRITICAL: Storage utilization above 95%
    Risk of hitting Cloudflare DO limits
    @pagerduty-critical
    
# Service Down Alert
service_down:
  name: "CF Search - Service Down"
  type: metric alert
  query: "avg(last_5m):cf_search.operations.count{*}.rate < 0.1"
  message: |
    🚨 CRITICAL: Search service appears to be down
    No operations detected in last 5 minutes
    @pagerduty-critical
```

#### B. Log-Based Alerts

```yaml
# SQL Injection Attempts
sql_injection_alert:
  name: "CF Search - Potential SQL Injection"
  type: log alert
  query: "service:cf-search error_type:ValidationError"
  threshold: 10
  timeframe: "10m"
  message: |
    Multiple validation errors detected - possible attack
    @security-team

# Database Corruption Alert
db_corruption_alert:
  name: "CF Search - Database Issues"
  type: log alert  
  query: "service:cf-search level:error message:*schema* OR message:*corruption*"
  threshold: 1
  timeframe: "1m"
  message: |
    🚨 Database schema or corruption error detected
    @dev-team-urgent
```

### 5. **SLO Configuration**

#### A. Service Level Objectives

```yaml
slos:
  # Availability SLO
  - name: "Search Service Availability"
    type: metric
    numerator: 'cf_search.operations.count{status:success}'
    denominator: 'cf_search.operations.count{*}'
    target: 99.9
    timeframe: 7d
    
  # Latency SLO
  - name: "Search Latency P95" 
    type: metric
    metric: 'cf_search.search.latency'
    target: 500  # 500ms
    timeframe: 7d
    
  # Index Success Rate SLO
  - name: "Index Success Rate"
    type: metric
    numerator: 'cf_search.operations.count{operation:index,status:success}'
    denominator: 'cf_search.operations.count{operation:index}'
    target: 99.5
    timeframe: 7d
```

### 6. **Advanced Monitoring Features**

#### A. Distributed Tracing (APM)

Add tracing to your worker:

```typescript
import { trace } from '@datadog/browser-logs';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const span = trace.startSpan('cf-search.request', {
      tags: {
        'http.method': request.method,
        'http.url': request.url,
        'service.version': '1.0.0',
      }
    });

    try {
      const response = await handleRequest(request, env, ctx);
      span.setTag('http.status_code', response.status);
      return response;
    } catch (error) {
      span.setTag('error', true);
      span.setTag('error.message', error.message);
      throw error;
    } finally {
      span.finish();
    }
  }
};
```

#### B. Real User Monitoring (RUM)

For frontend applications using the search service:

```javascript
import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
  applicationId: 'YOUR_APPLICATION_ID',
  clientToken: 'YOUR_CLIENT_TOKEN',
  site: 'datadoghq.com',
  service: 'cf-search-frontend',
  version: '1.0.0',
  sampleRate: 100,
  trackInteractions: true,
});

// Track search interactions
function performSearch(query) {
  datadogRum.addAction('search', {
    query: query,
    timestamp: Date.now(),
  });
}
```

### 7. **Advanced Monitoring Features**

#### A. Distributed Tracing (APM)

Add tracing to your worker:

```typescript
import { trace } from '@datadog/browser-logs';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const span = trace.startSpan('cf-search.request', {
      tags: {
        'http.method': request.method,
        'http.url': request.url,
        'service.version': '1.0.0',
      }
    });

    try {
      const response = await handleRequest(request, env, ctx);
      span.setTag('http.status_code', response.status);
      return response;
    } catch (error) {
      span.setTag('error', true);
      span.setTag('error.message', error.message);
      throw error;
    } finally {
      span.finish();
    }
  }
};
```

#### B. Real User Monitoring (RUM)

For frontend applications using the search service:

```javascript
import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
  applicationId: 'YOUR_APPLICATION_ID',
  clientToken: 'YOUR_CLIENT_TOKEN',
  site: 'datadoghq.com',
  service: 'cf-search-frontend',
  version: '1.0.0',
  sampleRate: 100,
  trackInteractions: true,
});

// Track search interactions
function performSearch(query) {
  datadogRum.addAction('search', {
    query: query,
    timestamp: Date.now(),
  });
}
```

### 8. **Automated Configuration Management**

#### A. Monitoring as Code Setup

The repository includes automated Datadog configuration management through CI/CD. All monitoring configuration is stored as code in `monitoring/datadog-config.yml` and automatically synced to your Datadog account.

**Benefits:**
- Version-controlled monitoring configuration
- Consistent environments (staging/production)
- Automated updates on deployment
- Reduced manual configuration errors

#### B. GitHub Secrets Configuration

Set up the required secrets in your GitHub repository:

```bash
# Required secrets for Datadog automation
DATADOG_API_KEY     # Your Datadog API key
DATADOG_APP_KEY     # Your Datadog Application key
DATADOG_SITE        # Optional: datadoghq.com (default), datadoghq.eu, etc.
```

**To add secrets:**
1. Go to your GitHub repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add each secret with the appropriate values

#### C. Configuration File Structure

The monitoring configuration is defined in `monitoring/datadog-config.yml`:

```yaml
# Example configuration structure
alerts:
  - name: "High Search Latency"
    metric: "cf_search.search.latency"
    aggregation: "p95"
    threshold: 1000
    comparison: ">"
    timeframe: "5m"
    severity: "warning"
    message: |
      Search latency P95 is above 1 second.
      Check dashboard for details.

log_alerts:
  - name: "Database Schema Errors"
    query: "service:cf-search level:error message:*schema*"
    threshold: 1
    timeframe: "5m"
    severity: "critical"
    message: |
      Database schema errors detected.
      Immediate investigation required.
```

#### D. Manual Sync

You can also run the sync manually:

```bash
# Install dependencies
npm install

# Set environment variables
export DATADOG_API_KEY="your-api-key"
export DATADOG_APP_KEY="your-app-key"
export DATADOG_SITE="datadoghq.com"  # Optional

# Run sync
npm run sync-datadog
```

#### E. Automation Features

**Automatic Sync Triggers:**
- ✅ Runs after every production deployment
- ✅ Only updates when configuration changes
- ✅ Validates configuration before applying
- ✅ Creates new monitors or updates existing ones
- ✅ Tags all resources for management

**Smart Updates:**
- Detects existing monitors by name or automation tags
- Updates existing monitors instead of creating duplicates
- Preserves manual changes to unmanaged monitors
- Provides detailed logging of all changes

**Configuration Validation:**
- Validates YAML syntax and structure
- Checks required fields for all monitor types
- Prevents deployment of invalid configurations
- Reports detailed error messages

#### F. Best Practices

1. **Always test configuration changes:**
   ```bash
   # Validate locally before committing
   npm run sync-datadog
   ```

2. **Use descriptive names and messages:**
   ```yaml
   alerts:
     - name: "CF Search - High Error Rate (>5%)"
       message: |
         Error rate exceeded 5% threshold.
         📊 Dashboard: https://app.datadoghq.com/dashboard/abc-123
         📖 Runbook: https://docs.company.com/runbooks/search-errors
   ```

3. **Organize by severity:**
   ```yaml
   alerts:
     # Critical alerts (require immediate action)
     - name: "CF Search - Service Down"
       severity: "critical"
       
     # Warning alerts (monitor closely)
     - name: "CF Search - High Latency"
       severity: "warning"
   ```

4. **Include context in alert messages:**
   ```yaml
   message: |
     🚨 CRITICAL: Search service appears down
     
     **Quick Actions:**
     1. Check Cloudflare Workers status
     2. Verify queue processing
     3. Review recent deployments
     
     **Escalation:** @pagerduty-critical
     **Dashboard:** https://app.datadoghq.com/dashboard/cf-search
   ```

#### G. Extending Automation

The sync script can be extended to handle additional Datadog resources:

```javascript
// Future extensions in scripts/sync-datadog.js
await this.syncDashboards(config.dashboards);
await this.syncSLOs(config.slos);
await this.syncSynthetics(config.synthetics);
```

This automation ensures your monitoring configuration stays in sync with your code changes and provides a reliable, repeatable deployment process for your observability stack.

### 9. **Cost Optimization**

#### A. Log Sampling

For high-volume environments, implement sampling:

```typescript
// Sample 10% of success logs, 100% of errors
const shouldLog = (level: string) => {
  if (level === 'error') return true;
  return Math.random() < 0.1;
};

if (shouldLog(level)) {
  this.logger.info(message, data);
}
```

#### B. Metric Optimization

Use metric summaries for high-cardinality data:

```typescript
// Instead of individual metrics per query
this.logger.searchMetrics({
  operation: "search",
  status: "success", 
  duration_ms: duration,
  // Avoid high-cardinality tags
  query_category: getQueryCategory(query), // Instead of actual query
});
```

## 📊 **Key Metrics to Monitor**

### **Performance Metrics**
- Search latency (P50, P95, P99)
- Index operation latency
- Queue processing time
- Cold storage access time

### **Error Metrics**
- Error rate by operation
- Error types and frequencies
- Validation failures
- Database errors

### **Storage Metrics**
- Database size utilization
- Document count trends
- Purge operation frequency
- Cold storage distribution

### **Business Metrics**
- Search result quality
- Query patterns and trends
- User engagement
- Feature usage

## 🚨 **Alert Runbooks**

### **High Latency Response**

1. **Check dashboard** for affected operations
2. **Examine error logs** for recent failures
3. **Verify storage utilization** - purge if needed
4. **Check queue backlog** - scale if necessary
5. **Review recent deployments** for regressions

### **Storage Critical Response**

1. **Immediate**: Check purge configuration
2. **Monitor**: Cold storage creation
3. **Investigate**: Unusual document growth
4. **Scale**: Additional cold storage if needed

### **Service Down Response**

1. **Check Cloudflare status** and worker health
2. **Verify** DO connectivity and queue status
3. **Review** recent configuration changes
4. **Escalate** to on-call engineer if unresolved

## 🔧 **Maintenance & Updates**

### **Monthly Tasks**
- Review SLO compliance
- Update alert thresholds based on trends
- Analyze cost and optimize sampling rates
- Review and update runbooks

### **Quarterly Tasks**
- Dashboard optimization based on usage
- Storage trend analysis and capacity planning
- Performance baseline updates
- Security log analysis

## 🎯 **Best Practices**

1. **Start Simple**: Begin with essential metrics and expand gradually
2. **Alert Fatigue**: Set appropriate thresholds to avoid noise
3. **Context**: Include runbook links in all alerts
4. **Testing**: Regularly test alert escalation paths
5. **Documentation**: Keep monitoring docs updated with code changes

This comprehensive monitoring setup ensures you have complete visibility into your Cloudflare search service's health, performance, and business impact. 🚀 