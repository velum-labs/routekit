import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "@velum-labs/routekit-runtime";

export const TELEMETRY_CATEGORIES = ["usage", "reliability", "adoption"] as const;
export type TelemetryCategory = (typeof TELEMETRY_CATEGORIES)[number];
export type TelemetryCategories = Record<TelemetryCategory, boolean>;

export const DEFAULT_TELEMETRY_CATEGORIES: Readonly<TelemetryCategories> = Object.freeze({
  usage: true,
  reliability: true,
  adoption: true
});

export type ConsentFile = {
  enabled: boolean;
  categories?: Partial<TelemetryCategories>;
  installId?: string;
  decidedAt?: string;
};
export type ConsentDecision = {
  enabled: boolean;
  source: "do-not-track" | "env" | "config" | "default";
  categories: TelemetryCategories;
  installId?: string;
};
export type ConsentOptions = {
  path: () => string;
  environmentVariable: string;
  doNotTrackVariable?: string;
  now?: () => Date;
  randomId?: () => string;
};

export type TelemetryFieldMap = Readonly<Record<string, readonly string[]>>;
export type TelemetryDestination = {
  provider: "posthog";
  host: string;
  configured: boolean;
};
export type TelemetryStatus = {
  enabled: boolean;
  source: ConsentDecision["source"];
  categories: TelemetryCategories;
  installIdPresent: boolean;
  destination: TelemetryDestination;
  schema: TelemetrySchemaInventory;
};

const truthy = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "on", "yes"].includes(value.toLowerCase());
const falsy = (value: string | undefined): boolean =>
  value !== undefined && ["0", "false", "off", "no"].includes(value.toLowerCase());

function categories(value: Partial<TelemetryCategories> | undefined): TelemetryCategories {
  return {
    usage: value?.usage ?? DEFAULT_TELEMETRY_CATEGORIES.usage,
    reliability: value?.reliability ?? DEFAULT_TELEMETRY_CATEGORIES.reliability,
    adoption: value?.adoption ?? DEFAULT_TELEMETRY_CATEGORIES.adoption
  };
}

export function createConsentManager(options: ConsentOptions) {
  let ephemeralInstallId: string | undefined;
  const nextId = (): string => (options.randomId ?? randomUUID)();
  const decidedAt = (): string => (options.now ?? (() => new Date()))().toISOString();
  const read = (): ConsentFile | undefined => {
    const path = options.path();
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const candidate = parsed as ConsentFile;
      if (typeof candidate.enabled !== "boolean") return undefined;
      const normalized: ConsentFile = {
        enabled: candidate.enabled,
        categories: categories(candidate.categories),
        ...(candidate.decidedAt !== undefined ? { decidedAt: candidate.decidedAt } : {})
      };
      if (
        candidate.enabled &&
        typeof candidate.installId === "string" &&
        candidate.installId.length > 0
      ) {
        normalized.installId = candidate.installId;
      }
      return normalized;
    } catch {
      return undefined;
    }
  };
  const write = (value: ConsentFile): void => {
    const path = options.path();
    const normalized: ConsentFile = {
      enabled: value.enabled,
      categories: categories(value.categories),
      ...(value.enabled && value.installId !== undefined ? { installId: value.installId } : {}),
      ...(value.decidedAt !== undefined ? { decidedAt: value.decidedAt } : {})
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    writeFileAtomic(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  const stableId = (file: ConsentFile | undefined): string => {
    if (file?.enabled && file.installId !== undefined) return file.installId;
    ephemeralInstallId ??= nextId();
    return ephemeralInstallId;
  };
  const resolve = (env: NodeJS.ProcessEnv = process.env): ConsentDecision => {
    const file = read();
    const selectedCategories = categories(file?.categories);
    if (truthy(env[options.doNotTrackVariable ?? "DO_NOT_TRACK"])) {
      return { enabled: false, source: "do-not-track", categories: selectedCategories };
    }
    const override = env[options.environmentVariable];
    if (falsy(override)) {
      return { enabled: false, source: "env", categories: selectedCategories };
    }
    if (truthy(override)) {
      return {
        enabled: true,
        source: "env",
        categories: selectedCategories,
        installId: stableId(file)
      };
    }
    if (file !== undefined) {
      if (!file.enabled)
        return { enabled: false, source: "config", categories: selectedCategories };
      return {
        enabled: true,
        source: "config",
        categories: selectedCategories,
        installId: stableId(file)
      };
    }
    return { enabled: false, source: "default", categories: selectedCategories };
  };
  return {
    path: options.path,
    read,
    resolve,
    enable(): ConsentFile {
      const existing = read();
      const file: ConsentFile = {
        enabled: true,
        categories: categories(existing?.categories),
        installId: existing?.enabled ? (existing.installId ?? nextId()) : nextId(),
        decidedAt: decidedAt()
      };
      ephemeralInstallId = file.installId;
      write(file);
      return file;
    },
    disable(): ConsentFile {
      ephemeralInstallId = undefined;
      const file: ConsentFile = {
        enabled: false,
        categories: categories(read()?.categories),
        decidedAt: decidedAt()
      };
      write(file);
      return file;
    },
    setCategory(category: TelemetryCategory, enabled: boolean): ConsentFile {
      const existing = read();
      const file: ConsentFile = {
        enabled: existing?.enabled ?? false,
        categories: { ...categories(existing?.categories), [category]: enabled },
        ...(existing?.enabled && existing.installId !== undefined
          ? { installId: existing.installId }
          : {}),
        decidedAt: decidedAt()
      };
      write(file);
      return file;
    },
    resetIdentity(env: NodeJS.ProcessEnv = process.env): ConsentFile | undefined {
      const decision = resolve(env);
      if (!decision.enabled) {
        ephemeralInstallId = undefined;
        const existing = read();
        if (existing?.enabled) {
          const disabled = {
            enabled: false,
            categories: categories(existing.categories),
            decidedAt: decidedAt()
          };
          write(disabled);
          return disabled;
        }
        return existing;
      }
      const installId = nextId();
      ephemeralInstallId = installId;
      const existing = read();
      if (existing?.enabled) {
        const file = {
          enabled: true,
          categories: categories(existing.categories),
          installId,
          decidedAt: decidedAt()
        };
        write(file);
        return file;
      }
      return undefined;
    },
    clear(): void {
      ephemeralInstallId = undefined;
      rmSync(options.path(), { force: true });
    }
  };
}

export const DURATION_BUCKETS = ["<1s", "1-10s", "10-60s", "1-5m", "5-30m", ">30m"] as const;
export function durationBucket(ms: number): (typeof DURATION_BUCKETS)[number] {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 1_800_000) return "5-30m";
  return ">30m";
}

export const TELEMETRY_OUTCOMES = ["success", "error", "cancelled"] as const;
const OUTCOMES = TELEMETRY_OUTCOMES;
export const COMMAND_PATHS = [
  "start",
  "stop",
  "status",
  "doctor",
  "usage",
  "usage.redeem",
  "leaderboard",
  "accounts.login",
  "accounts.add",
  "accounts.rename",
  "accounts.remove",
  "accounts.list",
  "accounts.status",
  "calls.inspect",
  "config.path",
  "config.show",
  "config.init",
  "config.edit",
  "config.import",
  "providers.add",
  "providers.remove",
  "providers.status",
  "models.list",
  "models.info",
  "remote.add",
  "remote.install",
  "remote.list",
  "remote.show",
  "remote.use",
  "remote.remove",
  "peer.add",
  "peer.show",
  "peer.remove",
  "token.issue",
  "token.list",
  "token.revoke",
  "codex",
  "claude",
  "codex.install",
  "codex.uninstall",
  "claude.install",
  "claude.uninstall",
  "daemon.reload",
  "daemon.auth.show",
  "daemon.service.install",
  "daemon.service.uninstall",
  "daemon.service.status",
  "daemon.logs",
  "daemon.restart",
  "daemon.upgrade",
  "eval.run",
  "eval.show",
  "policy.show"
] as const;
export const COMMAND_EXIT_KINDS = ["success", "usage_error", "command_error", "cancelled"] as const;
export const COMMAND_TARGET_KINDS = ["local", "remote", "peer"] as const;
export const COMMAND_OS_VALUES = ["darwin", "linux", "win32", "other"] as const;
export const COMMAND_ARCH_VALUES = ["arm64", "x64", "other"] as const;
export const COMMAND_NODE_MAJOR_VALUES = ["22", "23", "24", "25", "26", "other"] as const;
export const PRODUCT_OPERATIONS = [
  "config_update",
  "config_import",
  "config_reload",
  "provider_enable",
  "provider_disable",
  "account_enroll",
  "account_enroll_activate",
  "account_remove",
  "account_sync",
  "launcher_prepare",
  "token_issue",
  "token_revoke"
] as const;
const COUNT_BUCKETS = ["0", "1", "2-5", "6-20", ">20"] as const;
const TOKEN_BUCKETS = ["0", "1-1k", "1k-10k", "10k-100k", ">100k", "unknown"] as const;
const RETRY_BUCKETS = ["0", "1", "2", "3+"] as const;
const BILLING_MODES = ["metered-api", "subscription", "upstream-managed", "unknown"] as const;
const DIALECTS = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "openai-embeddings"
] as const;
const REQUEST_KINDS = ["chat", "responses", "messages", "embeddings"] as const;
const PREFERENCE_ACTIONS = ["master", "category", "identity-reset"] as const;
const DAEMON_ACTIONS = [
  "started",
  "stopped",
  "restarted",
  "reloaded",
  "roll_started",
  "roll_committed",
  "roll_failed"
] as const;

type Validator = (
  | { type: "boolean" }
  | { type: "string"; maxLength: number; values?: readonly string[]; canonical?: boolean }
) & { required?: false };
type EventDefinition = {
  category: TelemetryCategory;
  properties: Readonly<Record<string, Validator>>;
};

export const TELEMETRY_EVENT_DEFINITIONS = {
  "routekit.command_completed": {
    category: "adoption",
    properties: {
      command: { type: "string", maxLength: 64, values: COMMAND_PATHS },
      cli_version: { type: "string", maxLength: 32 },
      os: { type: "string", maxLength: 16, values: COMMAND_OS_VALUES },
      arch: { type: "string", maxLength: 16, values: COMMAND_ARCH_VALUES },
      node_major: { type: "string", maxLength: 8, values: COMMAND_NODE_MAJOR_VALUES },
      duration_bucket: { type: "string", maxLength: 16, values: DURATION_BUCKETS },
      outcome: { type: "string", maxLength: 16, values: OUTCOMES },
      exit_kind: { type: "string", maxLength: 24, values: COMMAND_EXIT_KINDS },
      is_ci: { type: "boolean" },
      target_kind: { type: "string", maxLength: 16, values: COMMAND_TARGET_KINDS }
    }
  },
  "routekit.product_operation_completed": {
    category: "adoption",
    properties: {
      operation: { type: "string", maxLength: 64, values: PRODUCT_OPERATIONS },
      outcome: { type: "string", maxLength: 16, values: OUTCOMES },
      duration_bucket: { type: "string", maxLength: 16, values: DURATION_BUCKETS },
      version: { type: "string", maxLength: 32 }
    }
  },
  "routekit.daemon_lifecycle": {
    category: "reliability",
    properties: {
      action: { type: "string", maxLength: 16, values: DAEMON_ACTIONS },
      outcome: { type: "string", maxLength: 16, values: OUTCOMES },
      supervisor: {
        type: "string",
        maxLength: 16,
        values: ["systemd", "launchd", "detached", "unknown"]
      },
      version: { type: "string", maxLength: 32 },
      reason: {
        type: "string",
        maxLength: 16,
        values: ["restart", "upgrade"],
        required: false
      },
      from_version: { type: "string", maxLength: 32, required: false },
      to_version: { type: "string", maxLength: 32, required: false },
      rollback_stage: { type: "string", maxLength: 32, required: false },
      duration_bucket: {
        type: "string",
        maxLength: 16,
        values: DURATION_BUCKETS,
        required: false
      },
      forced: { type: "boolean", required: false }
    }
  },
  "routekit.gateway_usage_summary": {
    category: "usage",
    properties: {
      provider: { type: "string", maxLength: 100, canonical: true },
      model: { type: "string", maxLength: 200, canonical: true },
      dialect: { type: "string", maxLength: 32, values: DIALECTS },
      request_kind: { type: "string", maxLength: 16, values: REQUEST_KINDS },
      stream: { type: "boolean" },
      billing_mode: { type: "string", maxLength: 32, values: BILLING_MODES },
      input_token_bucket: { type: "string", maxLength: 16, values: TOKEN_BUCKETS },
      output_token_bucket: { type: "string", maxLength: 16, values: TOKEN_BUCKETS },
      request_count_bucket: { type: "string", maxLength: 8, values: COUNT_BUCKETS },
      version: { type: "string", maxLength: 32 }
    }
  },
  "routekit.gateway_reliability_summary": {
    category: "reliability",
    properties: {
      provider: { type: "string", maxLength: 100, canonical: true },
      model: { type: "string", maxLength: 200, canonical: true },
      dialect: { type: "string", maxLength: 32, values: DIALECTS },
      request_kind: { type: "string", maxLength: 16, values: REQUEST_KINDS },
      stream: { type: "boolean" },
      outcome: { type: "string", maxLength: 16, values: OUTCOMES },
      latency_bucket: { type: "string", maxLength: 16, values: DURATION_BUCKETS },
      retry_bucket: { type: "string", maxLength: 8, values: RETRY_BUCKETS },
      failover: { type: "boolean" },
      request_count_bucket: { type: "string", maxLength: 8, values: COUNT_BUCKETS },
      version: { type: "string", maxLength: 32 }
    }
  },
  "routekit.telemetry_preference_changed": {
    category: "adoption",
    properties: {
      action: { type: "string", maxLength: 32, values: PREFERENCE_ACTIONS },
      category: { type: "string", maxLength: 16, values: TELEMETRY_CATEGORIES, required: false },
      enabled: { type: "boolean" },
      source: {
        type: "string",
        maxLength: 16,
        values: ["do-not-track", "env", "config", "default"]
      },
      version: { type: "string", maxLength: 32 }
    }
  }
} as const satisfies Record<string, EventDefinition>;

export type TelemetryEventName = keyof typeof TELEMETRY_EVENT_DEFINITIONS;
export type CommandCompletedProperties = {
  command: (typeof COMMAND_PATHS)[number];
  cli_version: string;
  os: (typeof COMMAND_OS_VALUES)[number];
  arch: (typeof COMMAND_ARCH_VALUES)[number];
  node_major: (typeof COMMAND_NODE_MAJOR_VALUES)[number];
  duration_bucket: (typeof DURATION_BUCKETS)[number];
  outcome: (typeof OUTCOMES)[number];
  exit_kind: (typeof COMMAND_EXIT_KINDS)[number];
  is_ci: boolean;
  target_kind: (typeof COMMAND_TARGET_KINDS)[number];
};
export type TelemetryEventProperties = {
  "routekit.command_completed": CommandCompletedProperties;
  "routekit.product_operation_completed": {
    operation: (typeof PRODUCT_OPERATIONS)[number];
    outcome: (typeof OUTCOMES)[number];
    duration_bucket: (typeof DURATION_BUCKETS)[number];
    version: string;
  };
  "routekit.daemon_lifecycle": {
    action: (typeof DAEMON_ACTIONS)[number];
    outcome: (typeof OUTCOMES)[number];
    supervisor: "systemd" | "launchd" | "detached" | "unknown";
    version: string;
    reason?: "restart" | "upgrade";
    from_version?: string;
    to_version?: string;
    rollback_stage?: string;
    duration_bucket?: (typeof DURATION_BUCKETS)[number];
    forced?: boolean;
  };
  /** Gateway summaries are the only families permitted to carry canonical provider/model identifiers. */
  "routekit.gateway_usage_summary": {
    provider: string;
    model: string;
    dialect: (typeof DIALECTS)[number];
    request_kind: (typeof REQUEST_KINDS)[number];
    stream: boolean;
    billing_mode: (typeof BILLING_MODES)[number];
    input_token_bucket: (typeof TOKEN_BUCKETS)[number];
    output_token_bucket: (typeof TOKEN_BUCKETS)[number];
    request_count_bucket: (typeof COUNT_BUCKETS)[number];
    version: string;
  };
  "routekit.gateway_reliability_summary": {
    provider: string;
    model: string;
    dialect: (typeof DIALECTS)[number];
    request_kind: (typeof REQUEST_KINDS)[number];
    stream: boolean;
    outcome: (typeof OUTCOMES)[number];
    latency_bucket: (typeof DURATION_BUCKETS)[number];
    retry_bucket: (typeof RETRY_BUCKETS)[number];
    failover: boolean;
    request_count_bucket: (typeof COUNT_BUCKETS)[number];
    version: string;
  };
  "routekit.telemetry_preference_changed": {
    action: (typeof PREFERENCE_ACTIONS)[number];
    category?: TelemetryCategory;
    enabled: boolean;
    source: ConsentDecision["source"];
    version: string;
  };
};

export type TelemetrySchemaInventory = Readonly<
  Record<
    TelemetryEventName,
    {
      category: TelemetryCategory;
      fields: readonly string[];
    }
  >
>;

export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_SCHEMA_INVENTORY = Object.freeze(
  Object.fromEntries(
    Object.entries(TELEMETRY_EVENT_DEFINITIONS).map(([name, definition]) => [
      name,
      { category: definition.category, fields: Object.keys(definition.properties) }
    ])
  )
) as unknown as TelemetrySchemaInventory;

const FORBIDDEN_KEYS =
  /(?:^|_)(?:id|label|path|body|prompt|response|error|cost|usage|timing|token|secret|key)(?:$|_)/i;
const FORBIDDEN_VALUE =
  /(?:bearer\s+|sk-[a-z0-9]|-----begin [a-z ]+private key-----|(?:^|\s)\/(?:users|home|var|tmp)\/)/i;
const CANONICAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

export type BuiltTelemetryEvent = {
  event: TelemetryEventName;
  category: TelemetryCategory;
  properties: Record<string, unknown> & {
    schema_version: 1;
    $process_person_profile: false;
    $ip: null;
  };
};

export function buildTelemetryEvent<N extends TelemetryEventName>(
  name: N,
  source: TelemetryEventProperties[N]
): BuiltTelemetryEvent {
  if (!Object.hasOwn(TELEMETRY_EVENT_DEFINITIONS, name)) {
    throw new TypeError(`unknown telemetry event: ${name}`);
  }
  const eventName = name as TelemetryEventName;
  const definition = TELEMETRY_EVENT_DEFINITIONS[eventName] as EventDefinition;
  const input = source as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (definition.properties[key] === undefined) {
      const sensitive = FORBIDDEN_KEYS.test(key) ? " sensitive" : "";
      throw new TypeError(`unknown${sensitive} telemetry property ${key} for ${name}`);
    }
  }
  for (const [key, validator] of Object.entries(definition.properties)) {
    if (validator.required !== false && input[key] === undefined) {
      throw new TypeError(`missing telemetry property ${key} for ${name}`);
    }
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const validator = definition.properties[key];
    if (validator === undefined) {
      const sensitive = FORBIDDEN_KEYS.test(key) ? " sensitive" : "";
      throw new TypeError(`unknown${sensitive} telemetry property ${key} for ${name}`);
    }
    if (validator.type === "boolean") {
      if (typeof value !== "boolean") throw new TypeError(`invalid telemetry property ${key}`);
    } else {
      if (typeof value !== "string" || value.length === 0 || value.length > validator.maxLength) {
        throw new TypeError(`invalid telemetry property ${key}`);
      }
      if (validator.values !== undefined && !validator.values.includes(value)) {
        throw new TypeError(`invalid telemetry property ${key}`);
      }
      if (validator.canonical && !CANONICAL_ID.test(value)) {
        throw new TypeError(`invalid telemetry property ${key}`);
      }
      if (FORBIDDEN_VALUE.test(value)) throw new TypeError(`forbidden telemetry value for ${key}`);
    }
    output[key] = value;
  }
  return {
    event: eventName,
    category: definition.category,
    properties: anonymousEventProperties({
      ...output,
      schema_version: TELEMETRY_SCHEMA_VERSION
    }) as BuiltTelemetryEvent["properties"]
  };
}

export function telemetryStatusMetadata(
  decision: ConsentDecision,
  destinationOrFields: TelemetryDestination | TelemetryFieldMap,
  schema: TelemetrySchemaInventory = TELEMETRY_SCHEMA_INVENTORY
):
  | TelemetryStatus
  | {
      enabled: boolean;
      source: ConsentDecision["source"];
      installId: string | null;
      fields: TelemetryFieldMap;
    } {
  if (
    !("provider" in destinationOrFields) ||
    !("host" in destinationOrFields) ||
    !("configured" in destinationOrFields)
  ) {
    return {
      enabled: decision.enabled,
      source: decision.source,
      installId: decision.installId ?? null,
      fields: destinationOrFields
    };
  }
  return {
    enabled: decision.enabled,
    source: decision.source,
    categories: decision.categories,
    installIdPresent: decision.installId !== undefined,
    destination: destinationOrFields as TelemetryDestination,
    schema
  };
}

export function anonymousEventProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  return { ...properties, $process_person_profile: false, $ip: null };
}

export async function boundedShutdown(
  shutdown: () => Promise<unknown>,
  timeoutMs = 2_000
): Promise<void> {
  await Promise.race([
    shutdown().then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}
