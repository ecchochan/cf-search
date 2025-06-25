export type Env = {
  INDEX_QUEUE: Queue;
  REGION_REPLICA_DO: DurableObjectNamespace;
  PRIMARY_INDEX_DO: DurableObjectNamespace;
  LOCAL_REPLICA_DO: DurableObjectNamespace;
  COLD_STORAGE_DO: DurableObjectNamespace;
  SEARCH_CACHE: KVNamespace;
  // Security environment variables
  ADMIN_TOKEN?: string;
  API_KEY?: string;
  // Monitoring environment variables
  DATADOG_API_KEY?: string;
  DATADOG_URL?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  MONITORING_WEBHOOK_URL?: string;
  MONITORING_WEBHOOK_AUTH?: string;
  ERROR_SAMPLING_RATE?: string;
  METRICS_SAMPLING_RATE?: string;
  TRACE_SAMPLING_RATE?: string;
};

export type Document = {
  id: string;
  content: string;
  [key: string]: unknown;
};

export interface ConfigureRequest {
  /** Interval between alarm calls in milliseconds */
  alarmIntervalMs?: number;

  /** Maximum number of documents before purging to cold storage */
  purgeThresholdDocs?: number;

  /** Target number of documents after purging (should be less than threshold) */
  purgeTargetDocs?: number;

  /** Prefix for cold storage DO names */
  coldStoragePrefix?: string;

  /** Maximum documents per cold storage DO before creating new one */
  coldStorageThresholdDocs?: number;

  /** List of replica configurations */
  replicas?: ReplicaInfo[];

  /** Whether this DO is read-only (used for cold storage) */
  isReadOnly?: boolean;

  /** Current cold storage index (for rolling cold storage) */
  currentColdStorageIndex?: number;

  /** Type of document IDs - affects FTS5 optimization */
  idType?: "string" | "integer";
}

export type ApiResponse = {
  success: boolean;
  message?: string;
  error?: string;
};

// Additional types for SearchIndexDO
export type ReplicaType = "region" | "local";

export type ReplicaInfo = {
  type: ReplicaType;
  name?: string;
  id?: string;
};

export interface DOConfig extends ConfigureRequest {
  /** Internal tracking properties */
  [key: string]: any;
}

export type SQLDocument = {
  rowid: number;
  id: string;
  content: string;
  rank?: number;
};

export type SearchResult = {
  id: string;
  content: string;
  rank: number;
};

export type ColdStorageMetadata = {
  doName: string;
  createdAt: number;
  documentCount: number;
  firstDocId: string;
  lastDocId: string;
};

/**
 * Statistics about a Durable Object's current state
 */
export interface DOStats {
  /** Number of documents stored */
  count: number;
  /** Actual database size in bytes (from storage.sql.databaseSize) */
  estimatedSize: number; // Note: This is now actual size, not estimated
  /** Whether this DO is read-only (for cold storage) */
  isReadOnly?: boolean;
}

export type ValidationError = {
  field: string;
  message: string;
  value?: unknown;
};

export type ValidationResult<T> = {
  valid: boolean;
  data: T | undefined;
  errors: ValidationError[];
};

/**
 * Validates a single document based on the configured ID type
 */
export function validateDocument(doc: any, idType: "string" | "integer" = "string"): ValidationResult<Document> {
  const errors: ValidationError[] = [];

  // Check if doc is an object
  if (!doc || typeof doc !== "object") {
    return {
      valid: false,
      data: undefined,
      errors: [{ field: "document", message: "Document must be an object", value: doc }],
    };
  }

  // Validate ID based on configured type
  if (idType === "integer") {
    if (typeof doc.id !== "number" || !Number.isInteger(doc.id) || doc.id < 0) {
      errors.push({
        field: "id",
        message: "ID must be a non-negative integer",
        value: doc.id,
      });
    }
  } else {
    // String ID validation (default)
    if (typeof doc.id !== "string") {
      errors.push({
        field: "id",
        message: "ID must be a string",
        value: doc.id,
      });
    } else if (doc.id.length === 0) {
      errors.push({
        field: "id",
        message: "ID cannot be empty",
        value: doc.id,
      });
    } else if (doc.id.length > 255) {
      errors.push({
        field: "id",
        message: "ID cannot be longer than 255 characters",
        value: doc.id,
      });
    }
  }

  // Validate content (same for both ID types)
  if (typeof doc.content !== "string") {
    errors.push({
      field: "content",
      message: "Content must be a string",
      value: doc.content,
    });
  } else if (doc.content.length === 0) {
    errors.push({
      field: "content",
      message: "Content cannot be empty",
      value: doc.content,
    });
  }

  return {
    valid: errors.length === 0,
    data: errors.length === 0 ? doc : undefined,
    errors,
  };
}

/**
 * Validates an array of documents based on the configured ID type
 */
export function validateDocuments(
  docs: unknown,
  idType: "string" | "integer" = "string"
): ValidationResult<Document[]> {
  if (!Array.isArray(docs)) {
    return {
      valid: false,
      data: undefined,
      errors: [{ field: "documents", message: "Input must be an array", value: docs }],
    };
  }

  if (docs.length === 0) {
    return { valid: true, data: [], errors: [] };
  }

  const errors: ValidationError[] = [];
  const validDocuments: Document[] = [];

  docs.forEach((doc, index) => {
    const result = validateDocument(doc, idType);
    if (result.valid && result.data) {
      validDocuments.push(result.data);
    } else {
      // Add index to field names for array context
      result.errors.forEach((error) => {
        errors.push({
          ...error,
          field: `documents[${index}].${error.field}`,
        });
      });
    }
  });

  return {
    valid: errors.length === 0,
    data: validDocuments.length > 0 ? validDocuments : undefined,
    errors,
  };
}

/**
 * Structured logging for Datadog monitoring
 */
export interface LogContext {
  service: "cf-search";
  version: string;
  environment: "development" | "staging" | "production";
  doId?: string;
  doType?: "primary" | "replica" | "cold-storage";
  region?: string;
}

export interface SearchMetrics {
  operation: "search" | "index" | "purge" | "sync" | "configure";
  status: "success" | "error" | "timeout";
  duration_ms: number;
  document_count?: number;
  result_count?: number;
  query_length?: number;
  batch_size?: number;
  error_type?: string;
  error_message?: string;
}

export interface StorageMetrics {
  database_size_bytes: number;
  document_count: number;
  storage_utilization_percent: number;
  purge_triggered: boolean;
  cold_storage_count?: number;
}

export interface PerformanceMetrics {
  search_latency_p50: number;
  search_latency_p95: number;
  search_latency_p99: number;
  index_throughput_per_second: number;
  queue_depth: number;
  concurrent_operations: number;
}

/**
 * Structured logger for Datadog integration
 */
export class SearchLogger {
  private context: LogContext;

  constructor(context: LogContext) {
    this.context = context;
  }

  private log(level: "info" | "warn" | "error", message: string, data: Record<string, unknown> = {}) {
    const logEntry = {
      "@timestamp": new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...data,
    };
    console.log(JSON.stringify(logEntry));
  }

  info(message: string, data?: Record<string, unknown>) {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>) {
    this.log("error", message, data);
  }

  // Specialized logging methods
  searchMetrics(metrics: SearchMetrics) {
    this.info("search_operation", {
      metrics_type: "search_operation",
      ...metrics,
    });
  }

  storageMetrics(metrics: StorageMetrics) {
    this.info("storage_status", {
      metrics_type: "storage_status",
      ...metrics,
    });
  }

  performanceMetrics(metrics: PerformanceMetrics) {
    this.info("performance_metrics", {
      metrics_type: "performance_metrics",
      ...metrics,
    });
  }

  businessMetrics(data: {
    unique_users?: number;
    total_searches?: number;
    popular_queries?: string[];
    success_rate?: number;
  }) {
    this.info("business_metrics", {
      metrics_type: "business_metrics",
      ...data,
    });
  }
}

/**
 * RPC Result types for native Durable Object method calls
 */
export interface IndexResult {
  success: boolean;
  indexed: number;
  error?: string;
  details?: string;
}

export interface SyncResult {
  success: boolean;
  synced: number;
  error?: string;
  details?: string;
}

export interface SearchParams {
  query: string;
  includeCold?: boolean;
  maxResults?: number;
}

/**
 * SearchIndexDO RPC interface for native method calls
 */
export interface SearchIndexDOStub extends DurableObjectStub {
  indexDocuments(documents: Document[]): Promise<IndexResult>;
  syncDocuments(documents: Document[]): Promise<SyncResult>;
  searchDocuments(params: SearchParams): Promise<SearchResult[]>;
  getStats(): Promise<DOStats>;
  configureRPC(config: ConfigureRequest): Promise<void>;
}
