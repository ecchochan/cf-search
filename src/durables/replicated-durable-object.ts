/**
 * Generic base class for Durable Objects with built-in replication support.
 * This abstracts the complex replication logic to be reusable across different DO types.
 */

import type { Env, ReplicaInfo } from "@/types";
import { DurableObject } from "cloudflare:workers";

/**
 * Generic log context for replicated DOs
 */
export interface ReplicatedLogContext {
  service: string;
  version: string;
  environment: string;
  doId: string;
  doType: string;
}

/**
 * Generic logger interface
 */
export interface ReplicatedLogger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/**
 * Simple console logger implementation
 */
export class ConsoleLogger implements ReplicatedLogger {
  constructor(private context: ReplicatedLogContext) {}

  private log(level: string, message: string, data?: Record<string, unknown>) {
    console.log(
      JSON.stringify({
        "@timestamp": new Date().toISOString(),
        level,
        message,
        ...this.context,
        ...data,
      })
    );
  }

  info(message: string, data?: Record<string, unknown>) {
    this.log("info", message, data);
  }

  error(message: string, data?: Record<string, unknown>) {
    this.log("error", message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    this.log("warn", message, data);
  }
}

/**
 * Configuration for replicated Durable Objects
 */
export interface ReplicatedDOConfig {
  /** List of replica configurations */
  replicas?: ReplicaInfo[];
  /** Interval between sync operations in milliseconds */
  alarmIntervalMs?: number;
  /** Whether this DO is read-only (for replicas) */
  isReadOnly?: boolean;
  /** Custom configuration properties */
  [key: string]: any;
}

/**
 * Sync result for generic replication
 */
export interface GenericSyncResult<T = any> {
  success: boolean;
  synced: number;
  error?: string;
  details?: T;
}

/**
 * Interface that replica stubs must implement
 */
export interface ReplicaDOStub<TData = any> extends DurableObjectStub {
  // RPC methods that replicas must implement
  syncData(data: TData[]): Promise<GenericSyncResult>;
  configure(config: ReplicatedDOConfig): Promise<void>;
  getStats(): Promise<any>;
}

/**
 * Abstract base class for Durable Objects with replication capabilities
 */
export abstract class ReplicatedDurableObject<TData = any, TEnv extends Env = Env> extends DurableObject<TEnv> {
  protected state: DurableObjectState;
  protected env: TEnv;
  protected config: ReplicatedDOConfig;
  protected logger: ReplicatedLogger;

  constructor(state: DurableObjectState, env: TEnv) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.config = {};

    // Initialize logger with context
    const logContext: ReplicatedLogContext = {
      service: this.getServiceName(),
      version: "1.0.0",
      environment: (globalThis as any).ENVIRONMENT || "development",
      doId: state.id.toString(),
      doType: this.getDOType(),
    };
    this.logger = new ConsoleLogger(logContext);

    // blockConcurrencyWhile ensures that other events wait until initialization is complete
    this.state.blockConcurrencyWhile(async () => {
      await this.initialize();
    });
  }

  /**
   * Get service name for logging - override in subclasses
   */
  protected getServiceName(): string {
    return "replicated-do";
  }

  /**
   * Get DO type for logging - override in subclasses
   */
  protected getDOType(): string {
    const doId = this.state.id.toString();
    if (doId.includes("cold")) return "cold-storage";
    if (doId.includes("replica")) return "replica";
    return "primary";
  }

  /**
   * Initialize the DO - must be implemented by subclasses
   */
  protected abstract initialize(): Promise<void>;

  /**
   * Get data to sync since last sync - must be implemented by subclasses
   */
  protected abstract getDataToSync(lastSyncId: string | number | null): Promise<TData[]>;

  /**
   * Apply synced data - must be implemented by subclasses
   */
  protected abstract applySyncedData(data: TData[]): Promise<number>;

  /**
   * Get the last sync ID - must be implemented by subclasses
   */
  protected abstract getLastSyncId(data: TData[]): string | number | null;

  /**
   * Get replica namespace based on replica type - must be implemented by subclasses
   */
  protected abstract getReplicaNamespace(replicaInfo: ReplicaInfo): DurableObjectNamespace | null;

  /**
   * Main fetch handler
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/configure":
          return await this.handleConfigureHTTP(request);
        case "/stats":
          return await this.handleStatsHTTP();
        case "/internal-sync":
          return await this.handleInternalSyncHTTP(request);
        default:
          // Let subclasses handle their specific endpoints
          return await this.handleCustomFetch(request);
      }
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  /**
   * Handle custom fetch endpoints - override in subclasses
   */
  protected async handleCustomFetch(request: Request): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  }

  /**
   * RPC Method: Sync data (generic version)
   */
  async syncData(data: TData[]): Promise<GenericSyncResult> {
    try {
      if (this.config.isReadOnly) {
        this.logger.error("Attempted to sync to read-only DO");
        return {
          success: false,
          synced: 0,
          error: "This is a read-only DO",
        };
      }

      const synced = await this.applySyncedData(data);

      this.logger.info(`Successfully synced ${synced} items`);

      return {
        success: true,
        synced,
      };
    } catch (error) {
      this.logger.error("Error syncing data", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        synced: 0,
        error: "Failed to sync data",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * RPC Method: Configure DO
   */
  async configure(config: ReplicatedDOConfig): Promise<void> {
    this.config = { ...this.config, ...config };
    await this.state.storage.put("config", this.config);
    this.logger.info("Configuration updated", { config: this.config });

    // Skip alarm setting in test environment
    const isTestEnvironment = (globalThis as any).VITEST;

    if (!isTestEnvironment && !this.config.isReadOnly) {
      // Set initial alarm if not already set
      const currentAlarm = await this.state.storage.getAlarm();
      if (!currentAlarm) {
        this.logger.info("Setting first alarm");
        await this.state.storage.setAlarm(Date.now() + 5000); // Start in 5s
      }
    }
  }

  /**
   * RPC Method: Get stats - can be overridden by subclasses
   */
  async getStats(): Promise<any> {
    return {
      isReadOnly: this.config.isReadOnly,
      replicaCount: this.config.replicas?.length || 0,
    };
  }

  /**
   * The alarm is used for periodic sync operations
   */
  async alarm(): Promise<void> {
    this.logger.info(`Alarm triggered for DO ${this.state.id.toString()}`);

    // Skip background tasks for read-only DOs
    if (this.config.isReadOnly) {
      this.logger.info("Read-only DO - skipping background tasks");
      return;
    }

    // Sync to replicas if configured
    if (this.config.replicas?.length) {
      await this.syncToReplicas();
    }

    // Allow subclasses to perform additional alarm tasks
    await this.onAlarm();

    // Set the next alarm
    const interval = this.config.alarmIntervalMs || 60_000; // Default to 60 seconds
    await this.state.storage.setAlarm(Date.now() + interval);
    this.logger.info(`Next alarm set in ${interval}ms`);
  }

  /**
   * Hook for subclasses to perform additional alarm tasks
   */
  protected async onAlarm(): Promise<void> {
    // Override in subclasses if needed
  }

  /**
   * Sync data to all configured replicas
   */
  protected async syncToReplicas(): Promise<void> {
    this.logger.info("Starting sync to replicas...");

    const lastSyncId = await this.state.storage.get<string | number>("lastSyncId");
    const dataToSync = await this.getDataToSync(lastSyncId || null);

    if (!dataToSync.length) {
      this.logger.info("No new data to sync");
      return;
    }

    this.logger.info(`Found ${dataToSync.length} items to sync`);

    // Sync to all replicas in parallel
    const replicaPromises = (this.config.replicas || []).map((replicaInfo) =>
      this.syncToReplica(replicaInfo, dataToSync)
    );

    await Promise.all(replicaPromises);

    // Update last sync ID
    const newLastSyncId = this.getLastSyncId(dataToSync);
    if (newLastSyncId !== null) {
      await this.state.storage.put("lastSyncId", newLastSyncId);
    }

    this.logger.info("Sync to replicas complete");
  }

  /**
   * Sync data to a specific replica
   */
  protected async syncToReplica(replicaInfo: ReplicaInfo, data: TData[]): Promise<void> {
    try {
      const stub = this.getReplicaStub(replicaInfo) as ReplicaDOStub<TData>;
      if (!stub) return;

      this.logger.info(`Syncing to replica: ${replicaInfo.name || replicaInfo.id || "unknown"}`);

      let result: GenericSyncResult;
      try {
        // Try RPC first
        result = await stub.syncData(data);
      } catch (error) {
        // Fallback to HTTP for test environment
        if (error instanceof TypeError && error.message.includes("subclass of")) {
          this.logger.info("RPC sync failed, falling back to HTTP");
          const httpResponse = await stub.fetch("http://do/internal-sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });

          if (httpResponse.ok) {
            result = (await httpResponse.json()) as GenericSyncResult;
          } else {
            throw new Error(`HTTP sync fallback failed: ${httpResponse.status}`);
          }
        } else {
          throw error;
        }
      }

      if (!result.success) {
        throw new Error(result.error || "Sync failed");
      }

      this.logger.info(`Successfully synced ${result.synced} items to replica`);
    } catch (error) {
      this.logger.error(`Failed to sync to replica ${replicaInfo.name || replicaInfo.id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get a Durable Object stub for a replica
   */
  protected getReplicaStub(replicaInfo: ReplicaInfo): ReplicaDOStub<TData> | null {
    try {
      const namespace = this.getReplicaNamespace(replicaInfo);
      if (!namespace) {
        this.logger.error("Could not get namespace for replica", { replicaInfo });
        return null;
      }

      if (replicaInfo.type === "region" && replicaInfo.name) {
        const id = namespace.idFromName(replicaInfo.name);
        return namespace.get(id, {
          locationHint: replicaInfo.name as DurableObjectLocationHint,
        }) as ReplicaDOStub<TData>;
      } else if (replicaInfo.type === "local" && replicaInfo.id) {
        const id = namespace.idFromString(replicaInfo.id);
        return namespace.get(id) as ReplicaDOStub<TData>;
      }

      this.logger.error("Invalid replica configuration", { replicaInfo });
      return null;
    } catch (error) {
      this.logger.error("Failed to create replica stub", {
        replicaInfo,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * HTTP Handler: Configure endpoint
   */
  protected async handleConfigureHTTP(request: Request): Promise<Response> {
    try {
      const config = (await request.json()) as ReplicatedDOConfig;
      await this.configure(config);
      return new Response("Configured", { status: 200 });
    } catch (error) {
      this.logger.error("Configure HTTP request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response("Internal server error", { status: 500 });
    }
  }

  /**
   * HTTP Handler: Stats endpoint
   */
  protected async handleStatsHTTP(): Promise<Response> {
    try {
      const stats = await this.getStats();
      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      this.logger.error("Stats HTTP request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response("Internal server error", { status: 500 });
    }
  }

  /**
   * HTTP Handler: Internal sync endpoint (for backward compatibility)
   */
  protected async handleInternalSyncHTTP(request: Request): Promise<Response> {
    try {
      const data = (await request.json()) as TData[];
      const result = await this.syncData(data);

      if (result.success) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } else {
        return new Response(JSON.stringify(result), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (error) {
      this.logger.error("Internal sync HTTP request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(JSON.stringify({ success: false, error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}
