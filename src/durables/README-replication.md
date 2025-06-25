# ReplicatedDurableObject - Generic Replication for Durable Objects

The `ReplicatedDurableObject` base class provides a generic, reusable implementation of the sophisticated replication logic found in SearchIndexDO. This allows any Durable Object to easily add replication capabilities.

## Key Features

- **Automatic Replication**: Sync data to regional and local replicas
- **Alarm-based Sync**: Periodic background synchronization
- **RPC Communication**: Native DO-to-DO communication with HTTP fallback
- **Location Hints**: Geographic routing for optimal performance
- **Read-only Replicas**: Support for read-only cold storage
- **Configurable**: Flexible configuration for different use cases

## Abstract Methods to Implement

When extending `ReplicatedDurableObject`, you must implement these methods:

```typescript
abstract class ReplicatedDurableObject<TData, TEnv extends Env> {
  // Initialize your DO
  protected abstract initialize(): Promise<void>;

  // Get data that needs to be synced since last sync
  protected abstract getDataToSync(lastSyncId: string | number | null): Promise<TData[]>;

  // Apply synced data from primary
  protected abstract applySyncedData(data: TData[]): Promise<number>;

  // Get the last sync ID from a batch of data
  protected abstract getLastSyncId(data: TData[]): string | number | null;

  // Get the namespace for replicas
  protected abstract getReplicaNamespace(replicaInfo: ReplicaInfo): DurableObjectNamespace | null;
}
```

## Example: Replicated Counter

Here's a simple example of a replicated counter:

```typescript
import { ReplicatedDurableObject } from "./replicated-durable-object";
import type { Env, ReplicaInfo } from "@/types";

interface CounterData {
  name: string;
  value: number;
  timestamp: number;
}

export class ReplicatedCounterDO extends ReplicatedDurableObject<CounterData> {
  private counters: Map<string, CounterData> = new Map();

  protected async initialize(): Promise<void> {
    // Load existing counters from storage
    const stored = await this.state.storage.list<CounterData>();
    for (const [key, value] of stored) {
      if (key !== "config" && key !== "lastSyncId") {
        this.counters.set(key, value);
      }
    }
  }

  protected async getDataToSync(lastSyncTimestamp: string | number | null): Promise<CounterData[]> {
    const lastSync = lastSyncTimestamp ? Number(lastSyncTimestamp) : 0;
    return Array.from(this.counters.values()).filter((c) => c.timestamp > lastSync);
  }

  protected async applySyncedData(data: CounterData[]): Promise<number> {
    let synced = 0;
    for (const counter of data) {
      const existing = this.counters.get(counter.name);
      if (!existing || existing.timestamp < counter.timestamp) {
        this.counters.set(counter.name, counter);
        await this.state.storage.put(counter.name, counter);
        synced++;
      }
    }
    return synced;
  }

  protected getLastSyncId(data: CounterData[]): string | number | null {
    return data.length > 0 ? Math.max(...data.map((d) => d.timestamp)) : null;
  }

  protected getReplicaNamespace(replicaInfo: ReplicaInfo): DurableObjectNamespace | null {
    return this.env.COUNTER_REPLICA_DO;
  }

  // Custom endpoints
  protected async handleCustomFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/increment":
        return this.handleIncrement(url);
      case "/get":
        return this.handleGet(url);
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  private async handleIncrement(url: URL): Promise<Response> {
    if (this.config.isReadOnly) {
      return new Response(JSON.stringify({ error: "Read-only replica" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const name = url.searchParams.get("name") || "default";
    const counter = this.counters.get(name) || { name, value: 0, timestamp: 0 };

    counter.value++;
    counter.timestamp = Date.now();

    this.counters.set(name, counter);
    await this.state.storage.put(name, counter);

    return new Response(JSON.stringify(counter), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGet(url: URL): Promise<Response> {
    const name = url.searchParams.get("name") || "default";
    const counter = this.counters.get(name) || { name, value: 0, timestamp: 0 };

    return new Response(JSON.stringify(counter), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
```

## Configuration

Configure replicas using the standard configuration:

```typescript
const config = {
  replicas: [
    { type: "region", name: "weur" }, // Western Europe
    { type: "region", name: "enam" }, // Eastern North America
    { type: "local", id: "local-1" }, // Local replica
  ],
  alarmIntervalMs: 30000, // Sync every 30 seconds
  isReadOnly: false, // Primary is read-write
};

// Configure via HTTP
await stub.fetch("/configure", {
  method: "POST",
  body: JSON.stringify(config),
});
```

## Worker Integration

Route requests to primary for writes and replicas for reads:

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Write operations go to primary
    if (url.pathname === "/increment") {
      const id = env.COUNTER_PRIMARY_DO.idFromName("primary");
      const stub = env.COUNTER_PRIMARY_DO.get(id);
      return stub.fetch(request);
    }

    // Read operations go to nearest replica
    const colo = request.cf?.colo || "auto";
    const id = env.COUNTER_REPLICA_DO.idFromName(colo);
    const stub = env.COUNTER_REPLICA_DO.get(id, {
      locationHint: colo as DurableObjectLocationHint,
    });
    return stub.fetch(request);
  },
};
```

## Benefits

1. **Code Reuse**: All replication logic is handled by the base class
2. **Consistency**: Same replication behavior across different DO types
3. **Flexibility**: Easy to customize sync behavior for specific needs
4. **Performance**: Built-in geographic routing and caching
5. **Reliability**: Automatic retry and error handling
6. **Monitoring**: Built-in logging and metrics

## Advanced Features

- **Custom Sync Logic**: Override `syncToReplica()` for custom sync behavior
- **Additional Alarms**: Use `onAlarm()` hook for additional periodic tasks
- **Custom Stats**: Override `getStats()` to add custom metrics
- **Different Namespaces**: Support multiple replica namespaces for different replica types

The `ReplicatedDurableObject` base class makes it easy to add sophisticated replication to any Durable Object with minimal code!
