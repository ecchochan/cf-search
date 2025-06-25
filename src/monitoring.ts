/**
 * Advanced monitoring and observability module
 * Supports integration with external services (Datadog, Sentry, Grafana, etc.)
 */

import type { Env, LogContext } from "./types";

/**
 * Monitoring configuration interface
 */
export interface MonitoringConfig {
  // Datadog configuration
  datadogApiKey?: string;
  datadogUrl?: string;

  // Sentry configuration
  sentryDsn?: string;
  sentryEnvironment?: string;

  // Custom webhook configuration
  webhookUrl?: string;
  webhookAuth?: string;

  // Local console logging (always enabled)
  enableConsoleLogging: boolean;

  // Sampling configuration
  errorSamplingRate: number; // 0.0 to 1.0
  metricsSamplingRate: number; // 0.0 to 1.0
  traceSamplingRate: number; // 0.0 to 1.0
}

/**
 * Metric types for different monitoring systems
 */
export interface MetricEvent {
  metric: string;
  value: number;
  timestamp: number;
  tags: Record<string, string>;
  type: "counter" | "gauge" | "histogram" | "timer";
}

export interface ErrorEvent {
  error: Error | string;
  context: Record<string, unknown>;
  level: "error" | "warning" | "info";
  timestamp: number;
  fingerprint?: string;
}

export interface TraceEvent {
  operation: string;
  duration: number;
  success: boolean;
  context: Record<string, unknown>;
  timestamp: number;
  traceId?: string;
  spanId?: string;
}

/**
 * Enhanced monitoring client that can send to multiple destinations
 */
export class AdvancedMonitor {
  private config: MonitoringConfig;
  private context: LogContext;

  constructor(context: LogContext, env: Env) {
    this.context = context;
    this.config = {
      datadogApiKey: env.DATADOG_API_KEY || "",
      datadogUrl: env.DATADOG_URL || "https://http-intake.logs.datadoghq.com/v1/input",
      sentryDsn: env.SENTRY_DSN || "",
      sentryEnvironment: env.SENTRY_ENVIRONMENT || context.environment,
      webhookUrl: env.MONITORING_WEBHOOK_URL || "",
      webhookAuth: env.MONITORING_WEBHOOK_AUTH || "",
      enableConsoleLogging: true,
      errorSamplingRate: parseFloat(env.ERROR_SAMPLING_RATE || "1.0"),
      metricsSamplingRate: parseFloat(env.METRICS_SAMPLING_RATE || "0.1"),
      traceSamplingRate: parseFloat(env.TRACE_SAMPLING_RATE || "0.05"),
    };
  }

  /**
   * Send metrics to configured monitoring services
   */
  async sendMetric(metric: MetricEvent): Promise<void> {
    // Apply sampling
    if (Math.random() > this.config.metricsSamplingRate) {
      return;
    }

    const enrichedMetric = {
      ...metric,
      tags: {
        ...metric.tags,
        service: this.context.service,
        version: this.context.version,
        environment: this.context.environment,
        doId: this.context.doId || "unknown",
        doType: this.context.doType || "unknown",
        region: this.context.region || "unknown",
      },
    };

    // Console logging (always enabled for debugging)
    if (this.config.enableConsoleLogging) {
      console.log(`METRIC: ${JSON.stringify(enrichedMetric)}`);
    }

    // Send to external services in parallel
    const promises: Promise<void>[] = [];

    if (this.config.datadogApiKey) {
      promises.push(this.sendToDatadog(enrichedMetric));
    }

    if (this.config.webhookUrl) {
      promises.push(this.sendToWebhook("metric", enrichedMetric));
    }

    // Don't await - fire and forget to avoid blocking
    Promise.allSettled(promises).catch((error) => {
      console.error("Error sending metrics:", error);
    });
  }

  /**
   * Send error events to monitoring services
   */
  async sendError(error: ErrorEvent): Promise<void> {
    // Apply sampling
    if (Math.random() > this.config.errorSamplingRate) {
      return;
    }

    const enrichedError = {
      ...error,
      context: {
        ...error.context,
        service: this.context.service,
        version: this.context.version,
        environment: this.context.environment,
        doId: this.context.doId,
        doType: this.context.doType,
        region: this.context.region,
      },
    };

    // Console logging
    if (this.config.enableConsoleLogging) {
      console.error(`ERROR: ${JSON.stringify(enrichedError)}`);
    }

    const promises: Promise<void>[] = [];

    if (this.config.sentryDsn) {
      promises.push(this.sendToSentry(enrichedError));
    }

    if (this.config.webhookUrl) {
      promises.push(this.sendToWebhook("error", enrichedError));
    }

    Promise.allSettled(promises).catch((err) => {
      console.error("Error sending error events:", err);
    });
  }

  /**
   * Send trace events for performance monitoring
   */
  async sendTrace(trace: TraceEvent): Promise<void> {
    // Apply sampling
    if (Math.random() > this.config.traceSamplingRate) {
      return;
    }

    const enrichedTrace = {
      ...trace,
      context: {
        ...trace.context,
        service: this.context.service,
        version: this.context.version,
        environment: this.context.environment,
        doId: this.context.doId,
        doType: this.context.doType,
      },
    };

    if (this.config.enableConsoleLogging) {
      console.log(`TRACE: ${JSON.stringify(enrichedTrace)}`);
    }

    const promises: Promise<void>[] = [];

    if (this.config.datadogApiKey) {
      promises.push(this.sendTraceToDatadog(enrichedTrace));
    }

    if (this.config.webhookUrl) {
      promises.push(this.sendToWebhook("trace", enrichedTrace));
    }

    Promise.allSettled(promises).catch((error) => {
      console.error("Error sending traces:", error);
    });
  }

  /**
   * Send metrics to Datadog
   */
  private async sendToDatadog(metric: MetricEvent): Promise<void> {
    if (!this.config.datadogApiKey || !this.config.datadogUrl) {
      return;
    }

    const payload = {
      ddsource: "cloudflare-worker",
      ddtags: Object.entries(metric.tags)
        .map(([k, v]) => `${k}:${v}`)
        .join(","),
      hostname: this.context.doId,
      message: JSON.stringify({
        metric: metric.metric,
        value: metric.value,
        type: metric.type,
        timestamp: metric.timestamp,
      }),
      level: "info",
      "@timestamp": new Date(metric.timestamp).toISOString(),
    };

    try {
      await fetch(this.config.datadogUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "DD-API-KEY": this.config.datadogApiKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error("Failed to send metric to Datadog:", error);
    }
  }

  /**
   * Send traces to Datadog APM
   */
  private async sendTraceToDatadog(trace: TraceEvent): Promise<void> {
    if (!this.config.datadogApiKey) {
      return;
    }

    // Datadog trace format
    const tracePayload = {
      traces: [
        [
          {
            trace_id: trace.traceId || this.generateTraceId(),
            span_id: trace.spanId || this.generateSpanId(),
            name: trace.operation,
            service: this.context.service,
            resource: trace.operation,
            duration: trace.duration * 1000000, // Convert to nanoseconds
            start: (trace.timestamp - trace.duration) * 1000000,
            error: trace.success ? 0 : 1,
            meta: {
              environment: this.context.environment,
              version: this.context.version,
              doType: this.context.doType || "unknown",
              ...Object.fromEntries(Object.entries(trace.context).map(([k, v]) => [k, String(v)])),
            },
          },
        ],
      ],
    };

    try {
      await fetch("https://trace.agent.datadoghq.com/v0.4/traces", {
        method: "POST",
        headers: {
          "Content-Type": "application/msgpack",
          "Datadog-Meta-Tracer-Version": "1.0.0",
          "X-Datadog-Trace-Count": "1",
        },
        body: JSON.stringify(tracePayload), // In production, use msgpack
      });
    } catch (error) {
      console.error("Failed to send trace to Datadog:", error);
    }
  }

  /**
   * Send errors to Sentry
   */
  private async sendToSentry(error: ErrorEvent): Promise<void> {
    if (!this.config.sentryDsn) {
      return;
    }

    const sentryPayload = {
      event_id: this.generateEventId(),
      timestamp: error.timestamp / 1000,
      level: error.level,
      platform: "javascript",
      environment: this.config.sentryEnvironment,
      server_name: this.context.doId,
      tags: {
        service: this.context.service,
        version: this.context.version,
        doType: this.context.doType,
      },
      extra: error.context,
      exception: {
        values: [
          {
            type: typeof error.error === "string" ? "Error" : error.error.constructor.name,
            value: typeof error.error === "string" ? error.error : error.error.message,
            stacktrace: typeof error.error === "object" ? { frames: [] } : undefined,
          },
        ],
      },
      fingerprint: error.fingerprint ? [error.fingerprint] : undefined,
    };

    const sentryUrl = new URL(this.config.sentryDsn);
    const projectId = sentryUrl.pathname.split("/").pop();
    const endpoint = `${sentryUrl.origin}/api/${projectId}/store/`;

    try {
      await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${sentryUrl.username}, sentry_client=cloudflare-worker/1.0.0`,
        },
        body: JSON.stringify(sentryPayload),
      });
    } catch (err) {
      console.error("Failed to send error to Sentry:", err);
    }
  }

  /**
   * Send to custom webhook
   */
  private async sendToWebhook(type: string, data: unknown): Promise<void> {
    if (!this.config.webhookUrl) {
      return;
    }

    const payload = {
      type,
      timestamp: Date.now(),
      source: "cloudflare-worker",
      context: this.context,
      data,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.webhookAuth) {
      headers["Authorization"] = this.config.webhookAuth;
    }

    try {
      await fetch(this.config.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error("Failed to send to webhook:", error);
    }
  }

  private generateTraceId(): string {
    return Math.floor(Math.random() * 0xffffffffffffffff).toString(16);
  }

  private generateSpanId(): string {
    return Math.floor(Math.random() * 0xffffffff).toString(16);
  }

  private generateEventId(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

/**
 * Convenience functions for common monitoring patterns
 */
export async function trackOperation<T>(
  monitor: AdvancedMonitor,
  operation: string,
  fn: () => Promise<T>,
  context: Record<string, unknown> = {}
): Promise<T> {
  const startTime = Date.now();
  const traceId = Math.floor(Math.random() * 0xffffffffffffffff).toString(16);

  try {
    const result = await fn();
    const duration = Date.now() - startTime;

    await monitor.sendTrace({
      operation,
      duration,
      success: true,
      context,
      timestamp: Date.now(),
      traceId,
    });

    await monitor.sendMetric({
      metric: `operation.${operation}.duration`,
      value: duration,
      timestamp: Date.now(),
      tags: { operation, status: "success" },
      type: "timer",
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    await monitor.sendTrace({
      operation,
      duration,
      success: false,
      context: { ...context, error: error instanceof Error ? error.message : String(error) },
      timestamp: Date.now(),
      traceId,
    });

    await monitor.sendError({
      error: error instanceof Error ? error : new Error(String(error)),
      context: { operation, ...context },
      level: "error",
      timestamp: Date.now(),
    });

    await monitor.sendMetric({
      metric: `operation.${operation}.errors`,
      value: 1,
      timestamp: Date.now(),
      tags: { operation, status: "error" },
      type: "counter",
    });

    throw error;
  }
}
