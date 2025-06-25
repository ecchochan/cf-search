# Automation Scripts

This directory contains automation scripts for managing external integrations and deployments.

## 🔍 Datadog Configuration Sync

### Overview

The `sync-datadog.js` script automates the synchronization of monitoring configuration from YAML files to your Datadog account. This implements "monitoring as code" practices, ensuring your alerts, dashboards, and SLOs are version-controlled and automatically deployed.

### Prerequisites

1. **Datadog Account** with API access
2. **API Keys** with appropriate permissions:
   - `DATADOG_API_KEY` - For API access
   - `DATADOG_APP_KEY` - For application-level operations

### Setup

#### 1. Local Development

```bash
# Set environment variables
export DATADOG_API_KEY="your-datadog-api-key"
export DATADOG_APP_KEY="your-datadog-application-key"
export DATADOG_SITE="datadoghq.com"  # Optional: defaults to datadoghq.com

# Install dependencies
npm install

# Run sync
npm run sync-datadog
```

#### 2. CI/CD Integration

The script automatically runs after production deployments. Configure these secrets in your GitHub repository:

- `DATADOG_API_KEY`
- `DATADOG_APP_KEY`
- `DATADOG_SITE` (optional)

### Configuration Format

The script reads from `monitoring/datadog-config.yml` and supports:

#### Metric Alerts

```yaml
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
      Check the dashboard for more details.
```

#### Formula-based Alerts

```yaml
alerts:
  - name: "High Error Rate"
    formula: "(cf_search.errors.count.rate / cf_search.operations.count.rate) * 100"
    threshold: 5
    comparison: ">"
    timeframe: "10m"
    severity: "warning"
    message: |
      Error rate is above 5%.
      @slack-alerts
```

#### Log Alerts

```yaml
log_alerts:
  - name: "Database Schema Errors"
    query: "service:cf-search level:error message:*schema*"
    threshold: 1
    timeframe: "5m"
    severity: "critical"
    message: |
      Database schema errors detected.
      @pagerduty-critical
```

### Features

#### Smart Resource Management
- **Automatic Detection**: Finds existing monitors by name or automation tags
- **Update vs Create**: Updates existing monitors, creates new ones as needed
- **Tagging**: All managed resources are tagged with `managed-by:cf-search-automation`
- **Validation**: Validates configuration before applying changes

#### Error Handling
- **Graceful Failures**: Continues processing if individual alerts fail
- **Detailed Logging**: Provides clear success/failure messages
- **Configuration Validation**: Catches errors before API calls

#### Safety Features
- **Non-destructive**: Never deletes existing monitors
- **Rollback Support**: Changes can be reverted through Datadog UI if needed
- **Audit Trail**: All changes are logged for tracking

### Usage Examples

#### Test Configuration Locally

```bash
# Dry run - validate configuration only
node scripts/sync-datadog.js --dry-run

# Full sync
npm run sync-datadog
```

#### Add a New Alert

1. Edit `monitoring/datadog-config.yml`:
   ```yaml
   alerts:
     - name: "Storage Critical"
       metric: "cf_search.storage.utilization_percent"
       threshold: 95
       comparison: ">"
       timeframe: "1m"
       severity: "critical"
       message: "Storage utilization critical! @pagerduty"
   ```

2. Test locally:
   ```bash
   npm run sync-datadog
   ```

3. Commit and push - CI will sync automatically

#### Update Existing Alert

1. Modify the alert in `monitoring/datadog-config.yml`
2. The script will detect and update the existing monitor

### Best Practices

#### 1. Use Descriptive Names
```yaml
# Good
- name: "CF Search - High Latency (P95 > 1s)"

# Avoid
- name: "Alert 1"
```

#### 2. Include Context in Messages
```yaml
message: |
  🚨 High search latency detected
  
  **Current Status:** P95 latency > 1 second
  **Dashboard:** https://app.datadoghq.com/dashboard/cf-search
  **Runbook:** https://docs.company.com/runbooks/search-latency
  
  @team-search @slack-alerts
```

#### 3. Use Appropriate Severities
- `critical`: Immediate action required, service impact
- `warning`: Monitor closely, potential issues
- `info`: Informational, no immediate action needed

#### 4. Tag Resources Consistently
All automated resources include these tags:
- `managed-by:cf-search-automation`
- `service:cf-search`
- `severity:{critical|warning|info}`

### Troubleshooting

#### Common Issues

1. **API Key Errors**
   ```
   ❌ Missing required environment variables
   ```
   **Solution**: Set `DATADOG_API_KEY` and `DATADOG_APP_KEY`

2. **Permission Errors**
   ```
   ❌ HTTP 403: Forbidden
   ```
   **Solution**: Ensure API keys have monitor write permissions

3. **Configuration Validation Errors**
   ```
   ❌ Alert High Latency: Missing threshold
   ```
   **Solution**: Check YAML syntax and required fields

#### Debug Mode

Enable debug logging:
```bash
DEBUG=1 npm run sync-datadog
```

### Extending the Script

The script is designed to be extensible. Future enhancements could include:

#### Dashboard Sync
```javascript
async syncDashboards(dashboardsConfig) {
  // Implementation for dashboard automation
}
```

#### SLO Management
```javascript
async syncSLOs(slosConfig) {
  // Implementation for SLO automation
}
```

#### Synthetic Tests
```javascript
async syncSynthetics(syntheticsConfig) {
  // Implementation for synthetic test automation
}
```

### Security Considerations

- **API Keys**: Store securely in GitHub Secrets, never commit to code
- **Permissions**: Use principle of least privilege for API keys
- **Audit**: All changes are logged and can be tracked
- **Rollback**: Manual rollback through Datadog UI if needed

This automation ensures your monitoring configuration is reliable, consistent, and maintainable across all environments. 