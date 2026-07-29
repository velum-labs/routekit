import type { ModelCallRecord } from "@velum-labs/routekit-gateway";
import {
  type BuiltTelemetryEvent,
  boundedShutdown,
  buildTelemetryEvent,
  type ConsentDecision,
  type TelemetryCategory,
  type TelemetryEventName,
  type TelemetryEventProperties
} from "@velum-labs/routekit-telemetry-core";
import { PostHog } from "posthog-node";

export const DEFAULT_TELEMETRY_HOST = "https://us.i.posthog.com";
export const DEFAULT_TELEMETRY_PROJECT_KEY = "phc_nDTdKsasUFwVC5a7mkUxGBUnJtrNsTMPeWcwSHEmT7zb";
export const DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_TELEMETRY_GROUP_LIMIT = 256;
export const DEFAULT_TELEMETRY_SHUTDOWN_TIMEOUT_MS = 2_000;

export function resolveTelemetryProjectKey(env: NodeJS.ProcessEnv): string {
  return env.ROUTEKIT_POSTHOG_KEY?.trim() || DEFAULT_TELEMETRY_PROJECT_KEY;
}

export type TelemetryTransportPayload = {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  disableGeoip: true;
};

export type TelemetryTransportClient = {
  capture(payload: TelemetryTransportPayload): void;
  flush(): Promise<void>;
  optOut?(): Promise<void> | void;
  shutdown(timeoutMs: number): Promise<void> | void;
};

export type TelemetryTransportFactory = (
  key: string,
  options: { host: string; flushAt: number; flushInterval: number; maxQueueSize: number }
) => TelemetryTransportClient;

const postHogFactory: TelemetryTransportFactory = (key, options) => {
  const client = new PostHog(key, {
    host: options.host,
    flushAt: options.flushAt,
    flushInterval: options.flushInterval,
    maxQueueSize: options.maxQueueSize,
    persistence: "memory",
    enableLocalEvaluation: false,
    enableExceptionAutocapture: false
  });
  return {
    capture: (payload) => client.capture(payload),
    flush: async () => await client.flush(),
    optOut: async () => await client.optOut(),
    shutdown: async (timeoutMs) => await client.shutdown(timeoutMs)
  };
};

export type DaemonTelemetryOptions = {
  env: NodeJS.ProcessEnv;
  resolveConsent: (env: NodeJS.ProcessEnv) => ConsentDecision;
  factory?: TelemetryTransportFactory;
  shutdownTimeoutMs?: number;
};

/** Daemon-owned, consent-gated transport. All payloads pass through the schema builder. */
export class DaemonTelemetry {
  readonly #env: NodeJS.ProcessEnv;
  readonly #resolveConsent: (env: NodeJS.ProcessEnv) => ConsentDecision;
  readonly #factory: TelemetryTransportFactory;
  readonly #shutdownTimeoutMs: number;
  #client: TelemetryTransportClient | undefined;
  #clientKey: string | undefined;
  #clientHost: string | undefined;

  constructor(options: DaemonTelemetryOptions) {
    this.#env = options.env;
    this.#resolveConsent = options.resolveConsent;
    this.#factory = options.factory ?? postHogFactory;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_TELEMETRY_SHUTDOWN_TIMEOUT_MS;
  }

  capture<N extends TelemetryEventName>(name: N, properties: TelemetryEventProperties[N]): boolean {
    let built: BuiltTelemetryEvent;
    try {
      built = buildTelemetryEvent(name, properties);
      const consent = this.#resolveConsent(this.#env);
      if (
        !consent.enabled ||
        !consent.categories[built.category] ||
        consent.installId === undefined
      ) {
        if (!consent.enabled || consent.installId === undefined) void this.#retireTransport(false);
        return false;
      }
      const client = this.#transport();
      if (client === undefined) return false;
      client.capture({
        distinctId: consent.installId,
        event: built.event,
        properties: built.properties,
        disableGeoip: true
      });
      return true;
    } catch {
      return false;
    }
  }

  permitted(category: TelemetryCategory): boolean {
    const consent = this.#resolveConsent(this.#env);
    const permitted =
      consent.enabled &&
      consent.categories[category] &&
      consent.installId !== undefined &&
      this.#key() !== undefined;
    if (!consent.enabled || consent.installId === undefined) void this.#retireTransport(false);
    return permitted;
  }

  async flush(): Promise<void> {
    try {
      const consent = this.#resolveConsent(this.#env);
      if (!consent.enabled || consent.installId === undefined) {
        await this.#retireTransport(false);
        return;
      }
      await boundedShutdown(async () => await this.#client?.flush(), this.#shutdownTimeoutMs);
    } catch {
      // Telemetry cannot affect product paths.
    }
  }

  async shutdown(): Promise<void> {
    await this.#retireTransport();
  }

  async resetTransport(): Promise<void> {
    await this.shutdown();
  }

  async discard(): Promise<void> {
    await this.#retireTransport(false);
  }

  #key(): string | undefined {
    return resolveTelemetryProjectKey(this.#env);
  }

  #retireTransport(flush = true): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#clientKey = undefined;
    this.#clientHost = undefined;
    if (client === undefined) return Promise.resolve();
    return boundedShutdown(async () => {
      if (!flush) await client.optOut?.();
      await client.shutdown(this.#shutdownTimeoutMs);
    }, this.#shutdownTimeoutMs);
  }

  #transport(): TelemetryTransportClient | undefined {
    const key = this.#key();
    if (key === undefined) {
      void this.#retireTransport();
      return undefined;
    }
    const host = this.#env.ROUTEKIT_POSTHOG_HOST?.trim() || DEFAULT_TELEMETRY_HOST;
    if (this.#client !== undefined && this.#clientKey === key && this.#clientHost === host)
      return this.#client;
    if (this.#client !== undefined) void this.#retireTransport();
    this.#client = this.#factory(key, {
      host,
      flushAt: 10,
      flushInterval: 10_000,
      maxQueueSize: 100
    });
    this.#clientKey = key;
    this.#clientHost = host;
    return this.#client;
  }
}

type UsageDimensions = Omit<
  TelemetryEventProperties["routekit.gateway_usage_summary"],
  "request_count_bucket" | "version"
>;
type ReliabilityDimensions = Omit<
  TelemetryEventProperties["routekit.gateway_reliability_summary"],
  "request_count_bucket" | "version"
>;
type SummaryDimensions = UsageDimensions & ReliabilityDimensions;
type SummaryEntry = {
  dimensions: SummaryDimensions;
  count: number;
  enqueued: Partial<Record<"usage" | "reliability", true>>;
};

type IntervalHandle = ReturnType<typeof setInterval>;
export type GatewayTelemetryAggregatorOptions = {
  telemetry: Pick<DaemonTelemetry, "capture" | "permitted">;
  version: string;
  groupLimit?: number;
  flushIntervalMs?: number;
  setInterval?: (callback: () => void, ms: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function tokenBucket(value: unknown): "0" | "1-1k" | "1k-10k" | "10k-100k" | ">100k" | "unknown" {
  const count = finite(value);
  if (count === undefined) return "unknown";
  if (count === 0) return "0";
  if (count < 1_000) return "1-1k";
  if (count < 10_000) return "1k-10k";
  if (count < 100_000) return "10k-100k";
  return ">100k";
}
function retryBucket(value: unknown): "0" | "1" | "2" | "3+" {
  const count = finite(value) ?? 0;
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count === 2) return "2";
  return "3+";
}
function countBucket(count: number): "1" | "2-5" | "6-20" | ">20" {
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 20) return "6-20";
  return ">20";
}
function latencyBucket(ms: unknown): "<1s" | "1-10s" | "10-60s" | "1-5m" | "5-30m" | ">30m" {
  const value = finite(ms) ?? 0;
  if (value < 1_000) return "<1s";
  if (value < 10_000) return "1-10s";
  if (value < 60_000) return "10-60s";
  if (value < 300_000) return "1-5m";
  if (value < 1_800_000) return "5-30m";
  return ">30m";
}

function dimensions(record: ModelCallRecord): SummaryDimensions | undefined {
  const metadata = object(record.metadata);
  const attribution = object(metadata?.attribution);
  const provider = typeof attribution?.provider === "string" ? attribution.provider : undefined;
  const model =
    typeof attribution?.effective_model === "string" ? attribution.effective_model : undefined;
  const rawDialect = metadata?.dialect;
  const dialect =
    rawDialect === "openai-chat" ||
    rawDialect === "openai-responses" ||
    rawDialect === "anthropic-messages" ||
    rawDialect === "openai-embeddings"
      ? rawDialect
      : undefined;
  if (provider === undefined || model === undefined || dialect === undefined) return undefined;
  const requestKind =
    dialect === "openai-chat"
      ? "chat"
      : dialect === "openai-responses"
        ? "responses"
        : dialect === "anthropic-messages"
          ? "messages"
          : "embeddings";
  const rawBilling = attribution?.billing_mode;
  const billingMode =
    rawBilling === "api_key"
      ? "metered-api"
      : rawBilling === "subscription"
        ? "subscription"
        : rawBilling === "client_auth"
          ? "upstream-managed"
          : "unknown";
  const usage = object(record.usage);
  return {
    provider,
    model,
    dialect,
    request_kind: requestKind,
    stream: metadata?.stream === true,
    billing_mode: billingMode,
    outcome: record.status === "succeeded" ? "success" : "error",
    latency_bucket: latencyBucket(record.latency_ms),
    retry_bucket: retryBucket(attribution?.retries),
    input_token_bucket: tokenBucket(usage?.prompt_tokens),
    output_token_bucket: tokenBucket(usage?.completion_tokens),
    failover: (finite(attribution?.account_failovers) ?? 0) > 0
  };
}

/** Bounded, in-memory gateway summaries; never retains raw call records. */
export class GatewayTelemetryAggregator {
  readonly #telemetry: GatewayTelemetryAggregatorOptions["telemetry"];
  readonly #version: string;
  readonly #groupLimit: number;
  readonly #flushIntervalMs: number;
  readonly #setInterval: NonNullable<GatewayTelemetryAggregatorOptions["setInterval"]>;
  readonly #clearInterval: NonNullable<GatewayTelemetryAggregatorOptions["clearInterval"]>;
  readonly #groups = new Map<string, SummaryEntry>();
  #timer: IntervalHandle | undefined;

  constructor(options: GatewayTelemetryAggregatorOptions) {
    this.#telemetry = options.telemetry;
    this.#version = options.version;
    this.#groupLimit = options.groupLimit ?? DEFAULT_TELEMETRY_GROUP_LIMIT;
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS;
    this.#setInterval = options.setInterval ?? setInterval;
    this.#clearInterval = options.clearInterval ?? clearInterval;
  }

  record(record: ModelCallRecord): void {
    try {
      if (!this.#telemetry.permitted("usage") && !this.#telemetry.permitted("reliability")) return;
      const value = dimensions(record);
      if (value === undefined) return;
      const key = JSON.stringify(value);
      const current = this.#groups.get(key);
      if (current !== undefined) current.count += 1;
      else if (this.#groups.size < this.#groupLimit)
        this.#groups.set(key, { dimensions: value, count: 1, enqueued: {} });
      this.#ensureTimer();
    } catch {
      // Aggregation cannot affect gateway calls.
    }
  }

  flush(): void {
    const usagePermitted = this.#telemetry.permitted("usage");
    const reliabilityPermitted = this.#telemetry.permitted("reliability");
    if (!usagePermitted && !reliabilityPermitted) {
      this.discard();
      return;
    }
    for (const [key, entry] of this.#groups) {
      const common = {
        provider: entry.dimensions.provider,
        model: entry.dimensions.model,
        dialect: entry.dimensions.dialect,
        request_kind: entry.dimensions.request_kind,
        stream: entry.dimensions.stream,
        request_count_bucket: countBucket(entry.count),
        version: this.#version
      };
      const usageCaptured =
        !usagePermitted ||
        entry.enqueued.usage === true ||
        this.#telemetry.capture("routekit.gateway_usage_summary", {
          ...common,
          billing_mode: entry.dimensions.billing_mode,
          input_token_bucket: entry.dimensions.input_token_bucket,
          output_token_bucket: entry.dimensions.output_token_bucket
        });
      if (usagePermitted && usageCaptured) entry.enqueued.usage = true;
      const reliabilityCaptured =
        !reliabilityPermitted ||
        entry.enqueued.reliability === true ||
        this.#telemetry.capture("routekit.gateway_reliability_summary", {
          ...common,
          outcome: entry.dimensions.outcome,
          latency_bucket: entry.dimensions.latency_bucket,
          retry_bucket: entry.dimensions.retry_bucket,
          failover: entry.dimensions.failover
        });
      if (reliabilityPermitted && reliabilityCaptured) entry.enqueued.reliability = true;
      if (usageCaptured && reliabilityCaptured) this.#groups.delete(key);
    }
    if (this.#groups.size === 0) this.#stopTimer();
  }

  size(): number {
    return this.#groups.size;
  }

  /** Drop buffered summaries for an opted-out family without sending them later. */
  discard(category?: "usage" | "reliability"): void {
    if (category === undefined) {
      this.#groups.clear();
    } else {
      for (const [key, entry] of this.#groups) {
        entry.enqueued[category] = true;
        if (entry.enqueued.usage === true && entry.enqueued.reliability === true) {
          this.#groups.delete(key);
        }
      }
    }
    if (this.#groups.size === 0) this.#stopTimer();
  }

  close(): void {
    this.#stopTimer();
    this.flush();
  }

  #ensureTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = this.#setInterval(() => this.flush(), this.#flushIntervalMs);
    this.#timer.unref?.();
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) this.#clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
