import { CF_REGIONS, DEFAULTS, TIME, buildConfig, buildGlobalReplicas, buildReplicas, configs, validateConfig } from "@/config";
import { describe, expect, it } from "vitest";

describe("Configuration", () => {
  describe("buildConfig", () => {
    it("should build development config with correct defaults", () => {
      const config = buildConfig("development");

      expect(config.alarmIntervalMs).toBe(10000); // 10 seconds
      expect(config.purgeThresholdDocs).toBe(1000);
      expect(config.purgeTargetDocs).toBe(800);
      expect(config.coldStorageThresholdDocs).toBe(500);
      expect(config.coldStoragePrefix).toBe("dev-cold");
      expect(config.replicas).toHaveLength(1);
      expect(config.replicas?.[0]?.type).toBe("local");
    });

    it("should build staging config with correct settings", () => {
      const config = buildConfig("staging");

      expect(config.alarmIntervalMs).toBe(DEFAULTS.ALARM_INTERVAL);
      expect(config.coldStoragePrefix).toBe("staging-cold");
      expect(config.replicas).toHaveLength(2);
      expect(config.replicas?.every((r) => r.type === "region")).toBe(true);
    });

    it("should build production config with global replicas", () => {
      const config = buildConfig("production");

      expect(config.coldStoragePrefix).toBe("prod-cold");
      expect(config.replicas?.length).toBeGreaterThan(5); // All regions except primary
      expect(config.replicas?.every((r) => r.type === "region")).toBe(true);
    });

    it("should default to development when no environment specified", () => {
      const config = buildConfig();

      expect(config.coldStoragePrefix).toBe("dev-cold");
      expect(config.alarmIntervalMs).toBe(10 * TIME.SECOND);
    });
  });

  describe("buildGlobalReplicas", () => {
    it("should create replicas for all regions except the excluded one", () => {
      const replicas = buildGlobalReplicas(CF_REGIONS.NORTH_AMERICA_WEST);

      expect(replicas.length).toBe(Object.keys(CF_REGIONS).length - 1);
      expect(replicas.every((r) => r.type === "region")).toBe(true);
      expect(replicas.every((r) => r.name !== CF_REGIONS.NORTH_AMERICA_WEST)).toBe(true);
    });

    it("should exclude primary region by default", () => {
      const replicas = buildGlobalReplicas();

      expect(replicas.some((r) => r.name === CF_REGIONS.NORTH_AMERICA_WEST)).toBe(false);
    });

    it("should include all other regions", () => {
      const replicas = buildGlobalReplicas(CF_REGIONS.NORTH_AMERICA_WEST);
      const regionNames = replicas.map((r) => r.name);

      expect(regionNames).toContain(CF_REGIONS.WESTERN_EUROPE);
      expect(regionNames).toContain(CF_REGIONS.SOUTH_EAST_ASIA);
      expect(regionNames).toContain(CF_REGIONS.NORTH_AMERICA_EAST);
    });
  });

  describe("buildReplicas", () => {
    it("should create regional replicas", () => {
      const regions = [CF_REGIONS.WESTERN_EUROPE, CF_REGIONS.SOUTH_EAST_ASIA];
      const replicas = buildReplicas(regions, 0);

      expect(replicas).toHaveLength(2);
      expect(replicas.every((r) => r.type === "region")).toBe(true);
      expect(replicas.map((r) => r.name)).toEqual(regions);
    });

    it("should create local replicas", () => {
      const replicas = buildReplicas([], 3);

      expect(replicas).toHaveLength(3);
      expect(replicas.every((r) => r.type === "local")).toBe(true);
      expect(replicas.map((r) => r.id)).toEqual(["local-replica-1", "local-replica-2", "local-replica-3"]);
    });

    it("should create both regional and local replicas", () => {
      const regions = [CF_REGIONS.WESTERN_EUROPE];
      const replicas = buildReplicas(regions, 2);

      expect(replicas).toHaveLength(3);
      expect(replicas.filter((r) => r.type === "region")).toHaveLength(1);
      expect(replicas.filter((r) => r.type === "local")).toHaveLength(2);
    });
  });

  describe("validateConfig", () => {
    it("should validate a correct configuration", () => {
      const config = {
        alarmIntervalMs: 30000,
        purgeThresholdDocs: 1000,
        purgeTargetDocs: 800,
        replicas: [
          { type: "region" as const, name: "weur" },
          { type: "local" as const, id: "local-1" },
        ],
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject alarm interval that is too short", () => {
      const config = { alarmIntervalMs: 500 };
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Alarm interval"))).toBe(true);
    });

    it("should reject purge target higher than threshold", () => {
      const config = {
        purgeThresholdDocs: 1000,
        purgeTargetDocs: 1500,
      };
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Purge target"))).toBe(true);
    });

    it("should reject regional replica without name", () => {
      const config = {
        replicas: [{ type: "region" as const }],
      };
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Regional replica must have a name"))).toBe(true);
    });

    it("should reject local replica without id", () => {
      const config = {
        replicas: [{ type: "local" as const }],
      };
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Local replica must have an id"))).toBe(true);
    });

    it("should reject duplicate regional replicas", () => {
      const config = {
        replicas: [
          { type: "region" as const, name: "weur" },
          { type: "region" as const, name: "weur" },
        ],
      };
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Duplicate regional replica"))).toBe(true);
    });

    it("should reject duplicate local replicas", () => {
      const config = {
        replicas: [
          { type: "local" as const, id: "local-1" },
          { type: "local" as const, id: "local-1" },
        ],
      };
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Duplicate local replica"))).toBe(true);
    });

    it("should collect multiple validation errors", () => {
      const config = {
        alarmIntervalMs: 500,
        purgeThresholdDocs: 1000,
        purgeTargetDocs: 1500,
        replicas: [{ type: "region" as const }, { type: "local" as const }],
      };
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe("configs convenience functions", () => {
    it("should provide development config", () => {
      const config = configs.development();
      expect(config.coldStoragePrefix).toBe("dev-cold");
    });

    it("should provide staging config", () => {
      const config = configs.staging();
      expect(config.coldStoragePrefix).toBe("staging-cold");
    });

    it("should provide production config", () => {
      const config = configs.production();
      expect(config.coldStoragePrefix).toBe("prod-cold");
    });

    it("should allow custom overrides", () => {
      const config = configs.custom({
        alarmIntervalMs: 5000,
        coldStoragePrefix: "custom-prefix",
      });

      expect(config.alarmIntervalMs).toBe(5000);
      expect(config.coldStoragePrefix).toBe("custom-prefix");
    });
  });
});
