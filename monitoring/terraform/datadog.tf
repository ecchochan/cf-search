# Terraform configuration for Datadog monitoring of Cloudflare Search Service
terraform {
  required_providers {
    datadog = {
      source = "DataDog/datadog"
      version = "~> 3.20"
    }
  }
}

# Configure the Datadog Provider
provider "datadog" {
  api_key = var.datadog_api_key
  app_key = var.datadog_app_key
  api_url = var.datadog_api_url
}

# Variables
variable "datadog_api_key" {
  description = "Datadog API Key"
  type        = string
  sensitive   = true
}

variable "datadog_app_key" {
  description = "Datadog Application Key"
  type        = string
  sensitive   = true
}

variable "datadog_api_url" {
  description = "Datadog API URL"
  type        = string
  default     = "https://api.datadoghq.com/"
}

variable "environment" {
  description = "Environment (development, staging, production)"
  type        = string
  default     = "production"
}

variable "alert_notification_targets" {
  description = "Notification targets for alerts"
  type        = list(string)
  default     = ["@slack-alerts", "@pagerduty"]
}

# Log Processing Pipeline
resource "datadog_logs_pipeline" "cf_search_processing" {
  name    = "cf-search-processing"
  enabled = true
  filter {
    query = "source:cloudflare service:cf-search"
  }

  # JSON Parser for Cloudflare logs
  processor {
    json_parser {
      name    = "cloudflare-json-parser"
      sources = ["message"]
      target  = "cloudflare"
    }
  }

  # Extract nested search log data
  processor {
    json_parser {
      name    = "search-logs-parser"
      sources = ["cloudflare.Logs.0.message"]
      target  = "search_log"
    }
  }

  # Date remapper
  processor {
    date_remapper {
      name    = "timestamp-remapper"
      sources = ["cloudflare.EventTimestampMs"]
    }
  }

  # Status remapper
  processor {
    status_remapper {
      name    = "status-remapper"
      sources = ["search_log.level"]
    }
  }

  # Service remapper
  processor {
    service_remapper {
      name    = "service-remapper"
      sources = ["search_log.service"]
    }
  }
}

# Custom Metrics from Logs
resource "datadog_logs_metric" "search_latency" {
  name  = "cf_search.search.latency"
  query = "source:cloudflare service:cf-search operation:search"
  
  compute {
    aggregation_type = "distribution"
    path             = "@search_log.duration_ms"
  }

  group_by {
    path     = "@search_log.status"
    tag_name = "status"
  }

  group_by {
    path     = "@search_log.doType"
    tag_name = "do_type"
  }
}

resource "datadog_logs_metric" "index_latency" {
  name  = "cf_search.index.latency"
  query = "source:cloudflare service:cf-search operation:index"
  
  compute {
    aggregation_type = "distribution"
    path             = "@search_log.duration_ms"
  }

  group_by {
    path     = "@search_log.status"
    tag_name = "status"
  }

  group_by {
    path     = "@search_log.doType"
    tag_name = "do_type"
  }
}

resource "datadog_logs_metric" "error_count" {
  name  = "cf_search.errors.count"
  query = "source:cloudflare service:cf-search status:error"
  
  compute {
    aggregation_type = "count"
  }

  group_by {
    path     = "@search_log.error_type"
    tag_name = "error_type"
  }

  group_by {
    path     = "@search_log.operation"
    tag_name = "operation"
  }
}

resource "datadog_logs_metric" "storage_size" {
  name  = "cf_search.storage.size_bytes"
  query = "source:cloudflare service:cf-search metrics_type:storage_status"
  
  compute {
    aggregation_type = "distribution"
    path             = "@search_log.database_size_bytes"
  }

  group_by {
    path     = "@search_log.doType"
    tag_name = "do_type"
  }

  group_by {
    path     = "@search_log.doId"
    tag_name = "do_id"
  }
}

# Dashboard
resource "datadog_dashboard" "cf_search_overview" {
  title       = "Cloudflare Search Service - Overview"
  description = "Comprehensive monitoring dashboard for CF Search Service"
  layout_type = "ordered"

  # Performance Section
  widget {
    group_definition {
      title            = "Performance Metrics"
      layout_type      = "ordered"
      background_color = "blue"

      widget {
        timeseries_definition {
          title = "Search Latency Percentiles"
          request {
            q = "p50:cf_search.search.latency{*}"
            display_type = "line"
            style {
              palette = "dog_classic"
            }
          }
          request {
            q = "p95:cf_search.search.latency{*}"
            display_type = "line"
          }
          request {
            q = "p99:cf_search.search.latency{*}"
            display_type = "line"
          }
          yaxis {
            min = 0
          }
        }
      }

      widget {
        timeseries_definition {
          title = "Operations per Second"
          request {
            q = "sum:cf_search.operations.count{*}.as_rate()"
            display_type = "bars"
          }
          yaxis {
            min = 0
          }
        }
      }
    }
  }

  # Error Section
  widget {
    group_definition {
      title            = "Error Tracking"
      layout_type      = "ordered"
      background_color = "red"

      widget {
        timeseries_definition {
          title = "Error Rate by Operation"
          request {
            q = "sum:cf_search.errors.count{*} by {operation}.as_rate()"
            display_type = "line"
          }
        }
      }

      widget {
        query_value_definition {
          title = "Success Rate %"
          request {
            q = "(sum:cf_search.operations.count{status:success}.as_rate() / sum:cf_search.operations.count{*}.as_rate()) * 100"
            aggregator = "avg"
          }
          precision = 2
        }
      }
    }
  }

  # Storage Section
  widget {
    group_definition {
      title            = "Storage Monitoring"
      layout_type      = "ordered"
      background_color = "yellow"

      widget {
        timeseries_definition {
          title = "Storage Utilization by DO Type"
          request {
            q = "avg:cf_search.storage.utilization_percent{*} by {do_type}"
            display_type = "line"
          }
          yaxis {
            min = 0
            max = 100
          }
        }
      }

      widget {
        timeseries_definition {
          title = "Database Size Growth"
          request {
            q = "avg:cf_search.storage.size_bytes{*} by {do_type}"
            display_type = "area"
          }
        }
      }
    }
  }
}

# Critical Alerts
resource "datadog_monitor" "high_search_latency" {
  name               = "CF Search - High Search Latency"
  type               = "metric alert"
  message            = <<EOF
Search latency P95 is above 1 second.
This may indicate performance degradation.
${join(" ", var.alert_notification_targets)}

Runbook: https://docs.company.com/runbooks/cf-search-latency
EOF
  escalation_message = "Search latency still high after 15 minutes"

  query = "avg(last_5m):p95:cf_search.search.latency{*} > 1000"

  monitor_thresholds {
    warning  = 800
    critical = 1000
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = ["service:cf-search", "severity:warning", "team:platform"]
}

resource "datadog_monitor" "storage_critical" {
  name    = "CF Search - Storage Critical"
  type    = "metric alert"
  message = <<EOF
🚨 CRITICAL: Storage utilization above 95%
Risk of hitting Cloudflare DO limits
${join(" ", var.alert_notification_targets)}
EOF

  query = "avg(last_1m):max:cf_search.storage.utilization_percent{*} > 95"

  monitor_thresholds {
    warning  = 80
    critical = 95
  }

  notify_no_data    = false
  renotify_interval = 30

  tags = ["service:cf-search", "severity:critical", "team:platform"]
}

resource "datadog_monitor" "service_down" {
  name    = "CF Search - Service Down"
  type    = "metric alert"
  message = <<EOF
🚨 CRITICAL: Search service appears to be down
No operations detected in last 5 minutes
${join(" ", var.alert_notification_targets)}
EOF

  query = "avg(last_5m):sum:cf_search.operations.count{*}.as_rate() < 0.1"

  monitor_thresholds {
    critical = 0.1
  }

  notify_no_data    = true
  no_data_timeframe = 10
  renotify_interval = 15

  tags = ["service:cf-search", "severity:critical", "team:platform"]
}

resource "datadog_monitor" "error_rate_high" {
  name    = "CF Search - High Error Rate"
  type    = "metric alert"
  message = <<EOF
Error rate is above 5% over the last 10 minutes.
Check application logs for issues.
${join(" ", var.alert_notification_targets)}
EOF

  query = "avg(last_10m):(sum:cf_search.errors.count{*}.as_rate() / sum:cf_search.operations.count{*}.as_rate()) * 100 > 5"

  monitor_thresholds {
    warning  = 3
    critical = 5
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = ["service:cf-search", "severity:warning", "team:platform"]
}

# Log-based Alerts
resource "datadog_monitor" "database_errors" {
  name    = "CF Search - Database Schema Errors"
  type    = "log alert"
  message = <<EOF
🚨 Database schema errors detected.
This may indicate corruption or migration issues.
${join(" ", var.alert_notification_targets)}
EOF

  query = "logs(\"service:cf-search level:error message:*schema*\").index(\"*\").rollup(\"count\").last(\"5m\") > 0"

  monitor_thresholds {
    critical = 1
  }

  tags = ["service:cf-search", "severity:critical", "team:platform"]
}

# SLO Definitions
resource "datadog_service_level_objective" "search_availability" {
  name        = "Search Service Availability"
  type        = "metric"
  description = "99.9% availability target for search service"

  query {
    numerator   = "sum:cf_search.operations.count{status:success}.as_count()"
    denominator = "sum:cf_search.operations.count{*}.as_count()"
  }

  thresholds {
    timeframe = "7d"
    target    = 99.9
    warning   = 99.5
  }

  tags = ["service:cf-search", "team:platform"]
}

resource "datadog_service_level_objective" "search_latency" {
  name        = "Search Latency P95"
  type        = "metric"
  description = "500ms P95 latency target for search operations"

  query {
    numerator   = "sum:cf_search.search.latency{*}.as_count()"
    denominator = "sum:cf_search.search.latency{*}.as_count()"
  }

  thresholds {
    timeframe = "7d"
    target    = 99.0  # 99% of requests under 500ms
    warning   = 95.0
  }

  tags = ["service:cf-search", "team:platform"]
}

# Outputs
output "dashboard_url" {
  description = "URL of the created dashboard"
  value       = datadog_dashboard.cf_search_overview.url
}

output "monitor_ids" {
  description = "IDs of created monitors"
  value = {
    high_latency    = datadog_monitor.high_search_latency.id
    storage_critical = datadog_monitor.storage_critical.id
    service_down    = datadog_monitor.service_down.id
    error_rate_high = datadog_monitor.error_rate_high.id
    database_errors = datadog_monitor.database_errors.id
  }
}

output "slo_ids" {
  description = "IDs of created SLOs"
  value = {
    availability = datadog_service_level_objective.search_availability.id
    latency      = datadog_service_level_objective.search_latency.id
  }
} 