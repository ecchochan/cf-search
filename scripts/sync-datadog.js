#!/usr/bin/env node

/**
 * Datadog Configuration Sync Script
 *
 * This script syncs monitoring configuration from YAML files to Datadog.
 * It handles alerts, dashboards, and SLOs as code.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

class DatadogSync {
  constructor() {
    this.apiKey = process.env.DATADOG_API_KEY;
    this.appKey = process.env.DATADOG_APP_KEY;
    this.baseUrl = process.env.DATADOG_SITE ? `https://api.${process.env.DATADOG_SITE}` : "https://api.datadoghq.com";

    if (!this.apiKey || !this.appKey) {
      console.error("❌ Missing required environment variables:");
      console.error("   DATADOG_API_KEY and DATADOG_APP_KEY must be set");
      process.exit(1);
    }

    console.log(`🔗 Using Datadog API: ${this.baseUrl}`);
  }

  async makeRequest(endpoint, method = "GET", body = null) {
    const url = `${this.baseUrl}/api/v1${endpoint}`;
    const headers = {
      "DD-API-KEY": this.apiKey,
      "DD-APPLICATION-KEY": this.appKey,
      "Content-Type": "application/json",
    };

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`❌ API request failed: ${method} ${endpoint}`);
      console.error(`   Error: ${error.message}`);
      throw error;
    }
  }

  async syncAlerts(alertsConfig) {
    console.log("\n📊 Syncing Datadog Alerts...");

    if (!alertsConfig || alertsConfig.length === 0) {
      console.log("   No alerts to sync");
      return;
    }

    for (const alertConfig of alertsConfig) {
      try {
        console.log(`   🔔 Processing alert: ${alertConfig.name}`);

        // Convert our YAML format to Datadog API format
        const datadogAlert = this.convertToDatadogMonitor(alertConfig);

        // Check if monitor already exists
        const existingMonitors = await this.makeRequest("/monitor");
        const existingMonitor = existingMonitors.find(
          (m) => m.name === alertConfig.name || m.tags?.includes(`managed-by:cf-search-automation`)
        );

        if (existingMonitor) {
          console.log(`   ↻ Updating existing monitor (ID: ${existingMonitor.id})`);
          await this.makeRequest(`/monitor/${existingMonitor.id}`, "PUT", datadogAlert);
        } else {
          console.log(`   ✚ Creating new monitor`);
          const result = await this.makeRequest("/monitor", "POST", datadogAlert);
          console.log(`   ✅ Created monitor ID: ${result.id}`);
        }
      } catch (error) {
        console.error(`   ❌ Failed to sync alert "${alertConfig.name}": ${error.message}`);
      }
    }
  }

  async syncLogAlerts(logAlertsConfig) {
    console.log("\n📝 Syncing Log-based Alerts...");

    if (!logAlertsConfig || logAlertsConfig.length === 0) {
      console.log("   No log alerts to sync");
      return;
    }

    for (const logAlert of logAlertsConfig) {
      try {
        console.log(`   📋 Processing log alert: ${logAlert.name}`);

        const datadogLogAlert = this.convertToDatadogLogMonitor(logAlert);

        // Check if monitor already exists
        const existingMonitors = await this.makeRequest("/monitor");
        const existingMonitor = existingMonitors.find(
          (m) => m.name === logAlert.name || m.tags?.includes(`managed-by:cf-search-automation`)
        );

        if (existingMonitor) {
          console.log(`   ↻ Updating existing log monitor (ID: ${existingMonitor.id})`);
          await this.makeRequest(`/monitor/${existingMonitor.id}`, "PUT", datadogLogAlert);
        } else {
          console.log(`   ✚ Creating new log monitor`);
          const result = await this.makeRequest("/monitor", "POST", datadogLogAlert);
          console.log(`   ✅ Created log monitor ID: ${result.id}`);
        }
      } catch (error) {
        console.error(`   ❌ Failed to sync log alert "${logAlert.name}": ${error.message}`);
      }
    }
  }

  convertToDatadogMonitor(alertConfig) {
    // Convert threshold comparison operators
    const operatorMap = {
      ">": "above",
      "<": "below",
      ">=": "above_or_equal",
      "<=": "below_or_equal",
      "=": "equal",
      "!=": "not_equal",
    };

    let query;
    if (alertConfig.formula) {
      // Handle formula-based alerts (like error rates)
      query = alertConfig.formula;
    } else {
      // Handle simple metric alerts
      const aggregation = alertConfig.aggregation || "avg";
      const timeframe = alertConfig.timeframe || "5m";
      query = `${aggregation}(last_${timeframe}):${alertConfig.metric}`;
    }

    return {
      name: alertConfig.name,
      type: "metric alert",
      query: query,
      message: alertConfig.message || `Alert triggered for ${alertConfig.name}`,
      tags: ["managed-by:cf-search-automation", "service:cf-search", `severity:${alertConfig.severity || "warning"}`],
      options: {
        notify_audit: false,
        require_full_window: false,
        notify_no_data: false,
        new_host_delay: 300,
        evaluation_delay: 60,
        thresholds: {
          critical: alertConfig.threshold,
          ...(alertConfig.warning_threshold && { warning: alertConfig.warning_threshold }),
        },
      },
    };
  }

  convertToDatadogLogMonitor(logAlert) {
    return {
      name: logAlert.name,
      type: "log alert",
      query: `logs("${logAlert.query}").index("*").rollup("count").last("${logAlert.timeframe}")`,
      message: logAlert.message || `Log alert triggered for ${logAlert.name}`,
      tags: ["managed-by:cf-search-automation", "service:cf-search", `severity:${logAlert.severity || "warning"}`],
      options: {
        notify_audit: false,
        require_full_window: false,
        notify_no_data: false,
        evaluation_delay: 60,
        thresholds: {
          critical: logAlert.threshold,
        },
      },
    };
  }

  async validateConfig(config) {
    console.log("\n🔍 Validating configuration...");

    const errors = [];

    // Validate alerts
    if (config.alerts) {
      config.alerts.forEach((alert, index) => {
        if (!alert.name) {
          errors.push(`Alert ${index}: Missing name`);
        }
        if (!alert.threshold && !alert.formula) {
          errors.push(`Alert ${alert.name || index}: Missing threshold or formula`);
        }
      });
    }

    // Validate log alerts
    if (config.log_alerts) {
      config.log_alerts.forEach((logAlert, index) => {
        if (!logAlert.name) {
          errors.push(`Log alert ${index}: Missing name`);
        }
        if (!logAlert.query) {
          errors.push(`Log alert ${logAlert.name || index}: Missing query`);
        }
        if (!logAlert.threshold) {
          errors.push(`Log alert ${logAlert.name || index}: Missing threshold`);
        }
      });
    }

    if (errors.length > 0) {
      console.error("❌ Configuration validation failed:");
      errors.forEach((error) => console.error(`   • ${error}`));
      return false;
    }

    console.log("✅ Configuration validation passed");
    return true;
  }

  async run() {
    console.log("🚀 Starting Datadog configuration sync...");

    try {
      // Load configuration
      const configPath = path.join(__dirname, "..", "monitoring", "datadog-config.yml");

      if (!fs.existsSync(configPath)) {
        console.error(`❌ Configuration file not found: ${configPath}`);
        process.exit(1);
      }

      console.log(`📖 Loading configuration from: ${configPath}`);
      const configContent = fs.readFileSync(configPath, "utf8");
      const config = yaml.load(configContent);

      // Validate configuration
      const isValid = await this.validateConfig(config);
      if (!isValid) {
        process.exit(1);
      }

      // Sync components
      await this.syncAlerts(config.alerts);
      await this.syncLogAlerts(config.log_alerts);

      console.log("\n✅ Datadog configuration sync completed successfully!");
    } catch (error) {
      console.error("\n❌ Sync failed:", error.message);
      process.exit(1);
    }
  }
}

// Run the sync if this script is executed directly
if (require.main === module) {
  const sync = new DatadogSync();
  sync.run();
}

module.exports = DatadogSync;
