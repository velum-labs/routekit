/**
 * Usage leaderboard aggregation over live call attribution and optional
 * durable hourly rollups under `$ROUTEKIT_HOME/usage/`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LeaderboardConfig } from "@velum-labs/routekit-config";
import type {
  RouteKitCallInspection,
  RouteKitControlParams,
  RouteKitLeaderboard
} from "@velum-labs/routekit-control";
import { writeFileAtomic } from "@velum-labs/routekit-runtime/filesystem";

export type LeaderboardDimension = RouteKitLeaderboard["by"];
export type LeaderboardSort = RouteKitLeaderboard["sort"];
export type LeaderboardWindow = NonNullable<RouteKitControlParams["calls.leaderboard"]["window"]>;

export const LEADERBOARD_ROLLUP_VERSION = 1 as const;
export const LEADERBOARD_ROLLUP_RELATIVE_PATH = join("usage", "leaderboard-rollups.v1.json");

export function defaultLeaderboardWindow(
  config: Pick<LeaderboardConfig, "durable" | "durableRetentionDays">
): LeaderboardWindow {
  if (!config.durable) return "live";
  return config.durableRetentionDays >= 7 ? "7d" : "24h";
}

type CounterBucket = {
  key: string;
  label?: string;
  requests: number;
  success: number;
  error: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  estimateUsd: number;
  unknownCostCount: number;
  unknownUsageCount: number;
  latencyMsSum: number;
  latencyMsCount: number;
  latencySamples?: number[];
};

type HourBucket = {
  hour: string;
  byPrincipal: Record<string, CounterBucket>;
  byModel: Record<string, CounterBucket>;
  byProvider: Record<string, CounterBucket>;
};

type RollupFile = {
  version: typeof LEADERBOARD_ROLLUP_VERSION;
  updatedAt: string;
  retentionDays: number;
  buckets: HourBucket[];
};

const WINDOW_MS: Record<Exclude<LeaderboardWindow, "live">, number> = {
  "1h": 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000
};

function emptyCounters(key: string, label?: string): CounterBucket {
  return {
    key,
    ...(label !== undefined ? { label } : {}),
    requests: 0,
    success: 0,
    error: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    estimateUsd: 0,
    unknownCostCount: 0,
    unknownUsageCount: 0,
    latencyMsSum: 0,
    latencyMsCount: 0
  };
}

function dimensionKey(
  inspection: RouteKitCallInspection,
  by: LeaderboardDimension
): { key: string; label?: string } | undefined {
  switch (by) {
    case "principal": {
      const tokenId = inspection.principal?.tokenId;
      if (tokenId === undefined) return undefined;
      return {
        key: tokenId,
        ...(inspection.principal?.label !== undefined ? { label: inspection.principal.label } : {})
      };
    }
    case "model":
      return { key: inspection.effectiveModel };
    case "provider":
      return { key: inspection.provider };
  }
}

function addInspection(
  bucket: CounterBucket,
  inspection: RouteKitCallInspection,
  keepSamples: boolean
): void {
  bucket.requests += 1;
  if (inspection.status === "succeeded") bucket.success += 1;
  else bucket.error += 1;
  const usage = inspection.usage;
  if (usage === undefined || inspection.cost.unknownUsage) {
    bucket.unknownUsageCount += 1;
  } else {
    bucket.tokensIn += usage.prompt_tokens ?? 0;
    bucket.tokensOut += usage.completion_tokens ?? 0;
    bucket.tokensTotal +=
      usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  }
  if (inspection.cost.estimateUsd !== undefined && !inspection.cost.unknownCost) {
    bucket.estimateUsd += inspection.cost.estimateUsd;
  } else if (inspection.cost.unknownCost || inspection.cost.estimateUsd === undefined) {
    bucket.unknownCostCount += 1;
  }
  const latencyMs = inspection.timing.latencyMs;
  if (latencyMs !== undefined) {
    bucket.latencyMsSum += latencyMs;
    bucket.latencyMsCount += 1;
    if (keepSamples) {
      bucket.latencySamples ??= [];
      bucket.latencySamples.push(latencyMs);
    }
  }
  if (
    bucket.label === undefined &&
    inspection.principal?.label !== undefined &&
    bucket.key === inspection.principal.tokenId
  ) {
    bucket.label = inspection.principal.label;
  }
}

function mergeCounters(target: CounterBucket, source: CounterBucket): void {
  target.requests += source.requests;
  target.success += source.success;
  target.error += source.error;
  target.tokensIn += source.tokensIn;
  target.tokensOut += source.tokensOut;
  target.tokensTotal += source.tokensTotal;
  target.estimateUsd += source.estimateUsd;
  target.unknownCostCount += source.unknownCostCount;
  target.unknownUsageCount += source.unknownUsageCount;
  target.latencyMsSum += source.latencyMsSum;
  target.latencyMsCount += source.latencyMsCount;
  if (target.label === undefined && source.label !== undefined) {
    target.label = source.label;
  }
}

function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return sorted[0];
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function sortValue(bucket: CounterBucket, sort: LeaderboardSort): number {
  switch (sort) {
    case "cost":
      return bucket.estimateUsd;
    case "requests":
      return bucket.requests;
    case "tokens":
      return bucket.tokensTotal;
    case "errors":
      return bucket.error;
    case "latency":
      return bucket.latencyMsCount === 0 ? 0 : bucket.latencyMsSum / bucket.latencyMsCount;
  }
}

function toRow(bucket: CounterBucket, rank: number): RouteKitLeaderboard["rows"][number] {
  const samples = bucket.latencySamples?.slice().sort((a, b) => a - b);
  const avg = bucket.latencyMsCount > 0 ? bucket.latencyMsSum / bucket.latencyMsCount : undefined;
  return {
    rank,
    key: bucket.key,
    ...(bucket.label !== undefined ? { label: bucket.label } : {}),
    requests: bucket.requests,
    success: bucket.success,
    error: bucket.error,
    tokensIn: bucket.tokensIn,
    tokensOut: bucket.tokensOut,
    tokensTotal: bucket.tokensTotal,
    ...(bucket.estimateUsd > 0 || bucket.unknownCostCount === 0
      ? { estimateUsd: bucket.estimateUsd }
      : {}),
    unknownCostCount: bucket.unknownCostCount,
    unknownUsageCount: bucket.unknownUsageCount,
    ...(avg !== undefined ? { latencyMsAvg: avg } : {}),
    ...(samples !== undefined
      ? {
          ...(percentile(samples, 50) !== undefined
            ? { latencyMsP50: percentile(samples, 50) }
            : {}),
          ...(percentile(samples, 95) !== undefined
            ? { latencyMsP95: percentile(samples, 95) }
            : {})
        }
      : {})
  };
}

export function aggregateInspections(
  inspections: readonly RouteKitCallInspection[],
  options: {
    by: LeaderboardDimension;
    sort: LeaderboardSort;
    limit: number;
  }
): {
  rows: RouteKitLeaderboard["rows"];
  sampleSize: number;
  windowStart?: string;
  windowEnd?: string;
} {
  const groups = new Map<string, CounterBucket>();
  let windowStart: string | undefined;
  let windowEnd: string | undefined;
  for (const inspection of inspections) {
    const dim = dimensionKey(inspection, options.by);
    if (dim === undefined) continue;
    let bucket = groups.get(dim.key);
    if (bucket === undefined) {
      bucket = emptyCounters(dim.key, dim.label);
      groups.set(dim.key, bucket);
    }
    addInspection(bucket, inspection, true);
    const started = inspection.timing.startedAt;
    if (windowStart === undefined || started < windowStart) windowStart = started;
    const finished = inspection.timing.finishedAt ?? started;
    if (windowEnd === undefined || finished > windowEnd) windowEnd = finished;
  }
  const ranked = [...groups.values()].sort((a, b) => {
    const delta = sortValue(b, options.sort) - sortValue(a, options.sort);
    if (delta !== 0) return delta;
    return a.key.localeCompare(b.key);
  });
  return {
    rows: ranked.slice(0, options.limit).map((bucket, index) => toRow(bucket, index + 1)),
    sampleSize: inspections.length,
    ...(windowStart !== undefined ? { windowStart } : {}),
    ...(windowEnd !== undefined ? { windowEnd } : {})
  };
}

function hourFloor(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    const fallback = new Date();
    fallback.setUTCMinutes(0, 0, 0);
    return fallback.toISOString();
  }
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function serializeBucket(bucket: CounterBucket): CounterBucket {
  const { latencySamples: _samples, ...rest } = bucket;
  return rest;
}

export class LeaderboardRollupStore {
  readonly #path: string;
  readonly #now: () => number;
  readonly #flushDelayMs: number;
  #enabled: boolean;
  #retentionDays: number;
  #file: RollupFile;
  #timer: NodeJS.Timeout | undefined;
  #dirty = false;

  constructor(options: {
    home: string;
    config: LeaderboardConfig;
    now?: () => number;
    flushDelayMs?: number;
  }) {
    this.#path = join(options.home, LEADERBOARD_ROLLUP_RELATIVE_PATH);
    this.#now = options.now ?? Date.now;
    this.#flushDelayMs = options.flushDelayMs ?? 250;
    this.#enabled = options.config.durable;
    this.#retentionDays = options.config.durableRetentionDays;
    this.#file = this.#load();
  }

  configure(config: Pick<LeaderboardConfig, "durable" | "durableRetentionDays">): void {
    this.#enabled = config.durable;
    this.#retentionDays = config.durableRetentionDays;
    this.#file.retentionDays = this.#retentionDays;
    this.#prune(this.#now());
    if (this.#enabled) this.#scheduleFlush();
  }

  record(inspection: RouteKitCallInspection): void {
    if (!this.#enabled) return;
    const hour = hourFloor(inspection.timing.startedAt);
    let bucket = this.#file.buckets.find((entry) => entry.hour === hour);
    if (bucket === undefined) {
      bucket = { hour, byPrincipal: {}, byModel: {}, byProvider: {} };
      this.#file.buckets.push(bucket);
      this.#file.buckets.sort((a, b) => a.hour.localeCompare(b.hour));
    }
    for (const by of ["principal", "model", "provider"] as const) {
      const dim = dimensionKey(inspection, by);
      if (dim === undefined) continue;
      const map =
        by === "principal"
          ? bucket.byPrincipal
          : by === "model"
            ? bucket.byModel
            : bucket.byProvider;
      let counters = map[dim.key];
      if (counters === undefined) {
        counters = emptyCounters(dim.key, dim.label);
        map[dim.key] = counters;
      }
      addInspection(counters, inspection, false);
      map[dim.key] = serializeBucket(counters);
    }
    this.#file.updatedAt = new Date(this.#now()).toISOString();
    this.#prune(this.#now());
    this.#dirty = true;
    this.#scheduleFlush();
  }

  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (!this.#dirty) return;
    this.#write();
  }

  query(options: {
    by: LeaderboardDimension;
    sort: LeaderboardSort;
    limit: number;
    window: Exclude<LeaderboardWindow, "live">;
  }): {
    rows: RouteKitLeaderboard["rows"];
    sampleSize: number;
    windowStart: string;
    windowEnd: string;
  } {
    this.flush();
    const endMs = this.#now();
    const startMs = endMs - WINDOW_MS[options.window];
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const groups = new Map<string, CounterBucket>();
    let sampleSize = 0;
    for (const hour of this.#file.buckets) {
      if (hour.hour < hourFloor(startIso)) continue;
      if (hour.hour > endIso) continue;
      const map =
        options.by === "principal"
          ? hour.byPrincipal
          : options.by === "model"
            ? hour.byModel
            : hour.byProvider;
      for (const counters of Object.values(map)) {
        sampleSize += counters.requests;
        let bucket = groups.get(counters.key);
        if (bucket === undefined) {
          bucket = emptyCounters(counters.key, counters.label);
          groups.set(counters.key, bucket);
        }
        mergeCounters(bucket, counters);
      }
    }
    const ranked = [...groups.values()].sort((a, b) => {
      const delta = sortValue(b, options.sort) - sortValue(a, options.sort);
      if (delta !== 0) return delta;
      return a.key.localeCompare(b.key);
    });
    return {
      rows: ranked.slice(0, options.limit).map((bucket, index) => toRow(bucket, index + 1)),
      sampleSize,
      windowStart: startIso,
      windowEnd: endIso
    };
  }

  path(): string {
    return this.#path;
  }

  #load(): RollupFile {
    if (!existsSync(this.#path)) {
      return {
        version: LEADERBOARD_ROLLUP_VERSION,
        updatedAt: new Date(this.#now()).toISOString(),
        retentionDays: this.#retentionDays,
        buckets: []
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<RollupFile>;
      if (parsed.version !== LEADERBOARD_ROLLUP_VERSION || !Array.isArray(parsed.buckets)) {
        return {
          version: LEADERBOARD_ROLLUP_VERSION,
          updatedAt: new Date(this.#now()).toISOString(),
          retentionDays: this.#retentionDays,
          buckets: []
        };
      }
      return {
        version: LEADERBOARD_ROLLUP_VERSION,
        updatedAt:
          typeof parsed.updatedAt === "string"
            ? parsed.updatedAt
            : new Date(this.#now()).toISOString(),
        retentionDays: this.#retentionDays,
        buckets: parsed.buckets
      };
    } catch {
      return {
        version: LEADERBOARD_ROLLUP_VERSION,
        updatedAt: new Date(this.#now()).toISOString(),
        retentionDays: this.#retentionDays,
        buckets: []
      };
    }
  }

  #prune(nowMs: number): void {
    const cutoff = new Date(nowMs - this.#retentionDays * 24 * 60 * 60 * 1_000);
    cutoff.setUTCMinutes(0, 0, 0);
    const cutoffIso = cutoff.toISOString();
    const before = this.#file.buckets.length;
    this.#file.buckets = this.#file.buckets.filter((bucket) => bucket.hour >= cutoffIso);
    if (this.#file.buckets.length !== before) this.#dirty = true;
  }

  #scheduleFlush(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#dirty) this.#write();
    }, this.#flushDelayMs);
    this.#timer.unref?.();
  }

  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.#path, `${JSON.stringify(this.#file, null, 2)}\n`, {
      mode: 0o600
    });
    chmodSync(this.#path, 0o600);
    this.#dirty = false;
  }
}

export function buildLeaderboardResult(input: {
  by: LeaderboardDimension;
  sort: LeaderboardSort;
  source: RouteKitLeaderboard["source"];
  windowStart: string;
  windowEnd: string;
  sampleSize: number;
  truncated: boolean;
  budget: LeaderboardConfig;
  rows: RouteKitLeaderboard["rows"];
}): RouteKitLeaderboard {
  return {
    by: input.by,
    sort: input.sort,
    source: input.source,
    window: {
      start: input.windowStart,
      end: input.windowEnd
    },
    sampleSize: input.sampleSize,
    truncated: input.truncated,
    budget: {
      liveLimit: input.budget.liveLimit,
      liveTtlHours: input.budget.liveTtlHours,
      durable: input.budget.durable,
      durableRetentionDays: input.budget.durableRetentionDays
    },
    rows: input.rows
  };
}
