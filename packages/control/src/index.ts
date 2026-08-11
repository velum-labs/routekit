import { createHash } from "node:crypto";
import type {
  AccountReadinessReason,
  CodexModelCandidate,
  ModelCallStatus,
  ModelCapabilityMetadata,
  ModelUsage,
  ProviderErrorKind,
  RequestBillingMode,
  UpstreamAuthState
} from "@velum-labs/routekit-contracts";
import type {
  ControlClientOptions,
  ControlHandler,
  ControlHandlerContext
} from "@velum-labs/routekit-runtime";
/**
 * Typed, versioned RouteKit daemon control protocol.
 *
 * This package defines product methods and validates their parameters. It is
 * independent of Commander and UI rendering; the CLI and daemon can evolve
 * independently as long as they negotiate the same protocol capability.
 */
import { ControlClient, ControlError } from "@velum-labs/routekit-runtime";
import {
  buildTelemetryEvent,
  type CommandCompletedProperties,
  type TelemetryCategory,
  type TelemetryStatus
} from "@velum-labs/routekit-telemetry-core";
import { IdempotencyStore } from "./idempotency-store.js";
import type { ControlMethodRegistry, ControlSchema } from "./method-registry.js";
import type {
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams,
  RouteKitControlResults
} from "./protocol.js";

export type {
  IdempotencyEntry,
  IdempotencyStoreOptions
} from "./idempotency-store.js";
export { IdempotencyStore } from "./idempotency-store.js";
export type {
  ControlAuthorization,
  ControlIdempotencyPolicy,
  ControlMethodDefinition,
  ControlMutationClassification,
  ControlSchema
} from "./method-registry.js";
export { ControlMethodRegistry } from "./method-registry.js";
export type {
  ConfigSnapshot,
  DaemonStatus,
  IssuedTokenResult,
  LaunchPreparation,
  ModelInfo,
  ModelRouteInfo,
  RouteKitAccountLimits,
  RouteKitAccountMemberStatus,
  RouteKitAccountStatusEntry,
  RouteKitAccountUsage,
  RouteKitCallInspection,
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams,
  RouteKitControlResults,
  RouteKitLeaderboard,
  RouteKitLeaderboardRow,
  RouteKitMethodHandler,
  RouteKitRateLimitObservationSource,
  RouteKitResetCredit,
  RouteKitResetCreditSnapshot,
  TokenListEntry,
  TokenPlane,
  TokenRole
} from "./protocol.js";
export { ROUTEKIT_CONTROL_CAPABILITY, ROUTEKIT_DAEMON_ROLL_CAPABILITY } from "./protocol.js";

const METHODS: ReadonlySet<string> = new Set<RouteKitControlMethod>([
  "daemon.status",
  "daemon.reload",
  "daemon.roll",
  "daemon.prepareShutdown",
  "config.get",
  "config.update",
  "config.import",
  "providers.status",
  "providers.set",
  "models.list",
  "models.info",
  "calls.inspect",
  "calls.leaderboard",
  "accounts.list",
  "accounts.status",
  "accounts.enroll",
  "accounts.enrollActivate",
  "accounts.remove",
  "accounts.rename",
  "accounts.sync",
  "accounts.usage",
  "accounts.resetCredits",
  "accounts.redeemReset",
  "telemetry.get",
  "telemetry.set",
  "telemetry.resetIdentity",
  "telemetry.schema",
  "telemetry.captureCommand",
  "doctor.run",
  "launcher.prepare",
  "tokens.issue",
  "tokens.list",
  "tokens.revoke"
]);

export const MUTATING_ROUTEKIT_METHODS: ReadonlySet<RouteKitControlMethod> = new Set([
  "daemon.reload",
  "daemon.roll",
  "daemon.prepareShutdown",
  "config.update",
  "config.import",
  "providers.set",
  "accounts.enroll",
  "accounts.enrollActivate",
  "accounts.remove",
  "accounts.rename",
  "accounts.sync",
  "accounts.redeemReset",
  "telemetry.set",
  "telemetry.resetIdentity",
  "tokens.issue",
  "tokens.revoke"
]);

function record(value: unknown, method: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} params must be an object`
    });
  }
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string, method: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} requires ${key}`
    });
  }
  return value;
}

function onlyKeys(
  params: Record<string, unknown>,
  method: string,
  allowed: readonly string[]
): void {
  const unknown = Object.keys(params).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} does not accept ${unknown}`
    });
  }
}

function requiredRevision(params: Record<string, unknown>, method: string): number {
  const value = params.expectedRevision;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} requires a non-negative expectedRevision`
    });
  }
  return value as number;
}

function requiredEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  method: string,
  allowed: readonly T[]
): T {
  const value = requiredString(params, key, method);
  if (!allowed.includes(value as T)) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} ${key} must be one of: ${allowed.join(", ")}`
    });
  }
  return value as T;
}

/**
 * Validate method-specific structural invariants at the protocol edge. Domain
 * parsers perform deeper validation (provider ids, router schema, credentials).
 */
export function validateRouteKitParams<M extends RouteKitControlMethod>(
  method: M,
  value: unknown
): RouteKitControlParams[M] {
  const params = record(value, method);
  switch (method) {
    case "config.update":
    case "config.import":
      requiredRevision(params, method);
      requiredString(params, "document", method);
      break;
    case "providers.set":
      requiredString(params, "provider", method);
      if (typeof params.enabled !== "boolean") {
        throw new ControlError({ code: "bad_request", message: `${method} requires enabled` });
      }
      break;
    case "models.info":
      requiredString(params, "model", method);
      break;
    case "calls.inspect":
      requiredString(params, "callId", method);
      break;
    case "calls.leaderboard":
      if (params.by !== undefined) {
        requiredEnum(params, "by", method, ["principal", "model", "provider"] as const);
      }
      if (params.sort !== undefined) {
        requiredEnum(params, "sort", method, [
          "cost",
          "requests",
          "tokens",
          "errors",
          "latency"
        ] as const);
      }
      if (params.window !== undefined) {
        requiredEnum(params, "window", method, ["live", "1h", "24h", "7d"] as const);
      }
      if (params.limit !== undefined) {
        if (!Number.isSafeInteger(params.limit) || (params.limit as number) < 1) {
          throw new ControlError({
            code: "bad_request",
            message: `${method} limit must be a positive integer`
          });
        }
      }
      break;
    case "accounts.enroll":
      requiredEnum(params, "kind", method, ["claude-code", "codex"] as const);
      requiredString(params, "label", method);
      if (params.credential === undefined) {
        throw new ControlError({ code: "bad_request", message: `${method} requires credential` });
      }
      break;
    case "accounts.enrollActivate":
      requiredString(params, "kind", method);
      if (!Array.isArray(params.accounts) || params.accounts.length === 0) {
        throw new ControlError({
          code: "bad_request",
          message: `${method} requires one or more accounts`
        });
      }
      for (const account of params.accounts) {
        const entry = record(account, method);
        requiredString(entry, "label", method);
      }
      break;
    case "accounts.remove":
      // Registry kinds and raw stored kinds are resolved by the daemon.
      requiredString(params, "kind", method);
      requiredString(params, "label", method);
      break;
    case "accounts.rename":
      requiredEnum(params, "kind", method, ["claude-code", "codex"] as const);
      requiredString(params, "source", method);
      requiredString(params, "target", method);
      break;
    case "accounts.resetCredits":
      requiredEnum(params, "kind", method, ["codex"] as const);
      requiredString(params, "label", method);
      break;
    case "accounts.redeemReset":
      requiredEnum(params, "kind", method, ["codex"] as const);
      requiredString(params, "label", method);
      if (params.creditId !== undefined) {
        requiredString(params, "creditId", method);
      }
      if (params.redeemRequestId !== undefined) {
        requiredString(params, "redeemRequestId", method);
      }
      break;
    case "telemetry.set": {
      onlyKeys(params, method, ["enabled", "category", "categoryEnabled"]);
      const hasMaster = params.enabled !== undefined;
      const hasCategory = params.category !== undefined || params.categoryEnabled !== undefined;
      if (!hasMaster && !hasCategory) {
        throw new ControlError({
          code: "bad_request",
          message: `${method} requires enabled or category change`
        });
      }
      if (hasMaster && typeof params.enabled !== "boolean") {
        throw new ControlError({
          code: "bad_request",
          message: `${method} enabled must be boolean`
        });
      }
      if (hasCategory) {
        requiredEnum(params, "category", method, ["usage", "reliability", "adoption"] as const);
        if (typeof params.categoryEnabled !== "boolean") {
          throw new ControlError({
            code: "bad_request",
            message: `${method} categoryEnabled must be boolean`
          });
        }
      }
      break;
    }
    case "telemetry.get":
    case "telemetry.resetIdentity":
    case "telemetry.schema":
      onlyKeys(params, method, []);
      break;
    case "telemetry.captureCommand": {
      const built = buildTelemetryEvent(
        "routekit.command_completed",
        params as CommandCompletedProperties
      );
      onlyKeys(
        params,
        method,
        Object.keys(built.properties).filter(
          (key) => !key.startsWith("$") && key !== "schema_version"
        )
      );
      return params as RouteKitControlParams[M];
    }
    case "launcher.prepare":
      requiredEnum(params, "tool", method, ["codex", "claude", "cursor", "opencode"] as const);
      break;
    case "daemon.prepareShutdown":
      requiredEnum(params, "reason", method, ["stop", "restart", "upgrade"] as const);
      break;
    case "daemon.roll":
      onlyKeys(params, method, ["reason", "expectedGeneration", "candidate"]);
      requiredEnum(params, "reason", method, ["restart", "upgrade"] as const);
      if (
        typeof params.expectedGeneration !== "number" ||
        !Number.isSafeInteger(params.expectedGeneration) ||
        params.expectedGeneration < 0
      ) {
        throw new ControlError({
          code: "bad_request",
          message: `${method} expectedGeneration must be a non-negative safe integer`
        });
      }
      if (params.candidate !== undefined) {
        if (
          typeof params.candidate !== "object" ||
          params.candidate === null ||
          Array.isArray(params.candidate)
        ) {
          throw new ControlError({
            code: "bad_request",
            message: `${method} candidate must be an object`
          });
        }
        onlyKeys(params.candidate as Record<string, unknown>, `${method} candidate`, [
          "binPath",
          "expectedVersion"
        ]);
        requiredString(
          params.candidate as Record<string, unknown>,
          "binPath",
          `${method} candidate`
        );
        requiredString(
          params.candidate as Record<string, unknown>,
          "expectedVersion",
          `${method} candidate`
        );
      }
      if (params.reason === "upgrade" && params.candidate === undefined) {
        throw new ControlError({
          code: "bad_request",
          message: `${method} upgrade requires a candidate`
        });
      }
      break;
    case "tokens.issue":
      requiredString(params, "label", method);
      requiredEnum(params, "plane", method, ["data", "control"] as const);
      break;
    case "tokens.list":
      if (params.plane !== undefined) {
        requiredEnum(params, "plane", method, ["data", "control"] as const);
      }
      break;
    case "tokens.revoke":
      requiredString(params, "id", method);
      break;
    default:
      break;
  }
  return params as RouteKitControlParams[M];
}

type ResultFieldKind = "array" | "boolean" | "number" | "object" | "string" | "true";

const RESULT_FIELDS = {
  "daemon.status": { pid: "number", packageVersion: "string", protocolVersion: "string" },
  "daemon.reload": { reloaded: "true", configRevision: "number", accountRevision: "number" },
  "daemon.roll": { rolled: "true", reason: "string", generation: "number" },
  "daemon.prepareShutdown": { accepted: "true" },
  "config.get": { path: "string", document: "string", revision: "number" },
  "config.update": { path: "string", document: "string", revision: "number" },
  "config.import": { path: "string", document: "string", revision: "number" },
  "providers.status": { providers: "array" },
  "providers.set": { path: "string", document: "string", revision: "number" },
  "models.list": { models: "array", revision: "number" },
  "models.info": {
    id: "string",
    provider: "string",
    nativeModel: "string",
    accountClass: "string",
    billingMode: "string",
    default: "boolean",
    capabilities: "object"
  },
  "calls.inspect": {
    callId: "string",
    status: "string",
    effectiveModel: "string",
    provider: "string",
    retries: "object",
    cost: "object",
    timing: "object"
  },
  "calls.leaderboard": { by: "string", sort: "string", rows: "array", budget: "object" },
  "accounts.list": { accounts: "array", revision: "number" },
  "accounts.status": { accounts: "array", revision: "number", recovery: "object" },
  "accounts.enroll": { enrolled: "true", revision: "number" },
  "accounts.enrollActivate": {
    enrolled: "array",
    activated: "true",
    configPath: "string",
    configRevision: "number",
    accountRevision: "number"
  },
  "accounts.remove": { removed: "boolean", revision: "number" },
  "accounts.rename": { renamed: "true", revision: "number" },
  "accounts.sync": { synced: "true", revision: "number" },
  "accounts.usage": { accountSets: "array" },
  "accounts.resetCredits": { kind: "string", label: "string", resetCredits: "object" },
  "accounts.redeemReset": {
    ok: "boolean",
    code: "string",
    kind: "string",
    label: "string",
    redeemRequestId: "string",
    usage: "object"
  },
  "telemetry.get": {
    enabled: "boolean",
    source: "string",
    categories: "object",
    installIdPresent: "boolean",
    destination: "object",
    schema: "object"
  },
  "telemetry.set": {
    enabled: "boolean",
    source: "string",
    categories: "object",
    installIdPresent: "boolean",
    destination: "object",
    schema: "object"
  },
  "telemetry.resetIdentity": {
    enabled: "boolean",
    source: "string",
    categories: "object",
    installIdPresent: "boolean",
    destination: "object",
    schema: "object"
  },
  "telemetry.schema": {},
  "telemetry.captureCommand": { accepted: "boolean" },
  "doctor.run": { checks: "array" },
  "launcher.prepare": {
    tool: "string",
    model: "string",
    gatewayUrl: "string",
    env: "object"
  },
  "tokens.issue": {
    id: "string",
    label: "string",
    plane: "string",
    role: "string",
    token: "string"
  },
  "tokens.list": { tokens: "array" },
  "tokens.revoke": {
    id: "string",
    label: "string",
    plane: "string",
    role: "string",
    createdAt: "string"
  }
} as const satisfies Record<RouteKitControlMethod, Readonly<Record<string, ResultFieldKind>>>;

function validResultField(value: unknown, kind: ResultFieldKind): boolean {
  if (kind === "array") return Array.isArray(value);
  if (kind === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  if (kind === "true") return value === true;
  return typeof value === kind;
}

export function validateRouteKitResult<M extends RouteKitControlMethod>(
  method: M,
  value: unknown
): RouteKitControlResults[M] {
  let result: Record<string, unknown>;
  try {
    result = record(value, `${method} result`);
  } catch (error) {
    throw new ControlError({
      code: "internal",
      message: `${method} handler returned an invalid result`,
      details: {
        reason: error instanceof Error ? error.message : String(error)
      }
    });
  }
  for (const [field, kind] of Object.entries(RESULT_FIELDS[method])) {
    if (!validResultField(result[field], kind)) {
      throw new ControlError({
        code: "internal",
        message: `${method} handler returned an invalid result field: ${field}`
      });
    }
  }
  return result as RouteKitControlResults[M];
}

export function routeKitControlSchemas<M extends RouteKitControlMethod>(
  method: M
): {
  paramsSchema: ControlSchema<RouteKitControlParams[M]>;
  resultSchema: ControlSchema<RouteKitControlResults[M]>;
} {
  return {
    paramsSchema: {
      name: `${method}.params`,
      parse: (value) => validateRouteKitParams(method, value)
    },
    resultSchema: {
      name: `${method}.result`,
      parse: (value) => validateRouteKitResult(method, value)
    }
  };
}

export function createRouteKitControlHandler(
  handlers: RouteKitControlHandlers,
  options: {
    idempotencyCacheSize?: number;
    idempotencyTtlMs?: number;
    idempotencyStore?: IdempotencyStore;
    registry?: Pick<ControlMethodRegistry, "definition">;
    onCommitted?: (
      method: RouteKitControlMethod,
      params: RouteKitControlParams[RouteKitControlMethod],
      durationMs: number
    ) => void;
    onControlError?: (
      method: RouteKitControlMethod,
      params: RouteKitControlParams[RouteKitControlMethod],
      code: ControlError["code"],
      durationMs: number
    ) => void;
  } = {}
): ControlHandler {
  const operations =
    options.idempotencyStore ??
    new IdempotencyStore({
      maxEntries: options.idempotencyCacheSize,
      ttlMs: options.idempotencyTtlMs
    });
  return async (rawMethod, params, context) => {
    if (!METHODS.has(rawMethod)) {
      throw new ControlError({
        code: "not_found",
        message: `unknown RouteKit control method: ${rawMethod}`
      });
    }
    const method = rawMethod as RouteKitControlMethod;
    const key =
      MUTATING_ROUTEKIT_METHODS.has(method) && context.idempotencyKey !== undefined
        ? `${method}:${context.idempotencyKey}`
        : undefined;
    const schemas = options.registry?.definition(method) ?? routeKitControlSchemas(method);
    const validated = schemas.paramsSchema.parse(params);
    const fingerprint = createHash("sha256").update(JSON.stringify(validated)).digest("hex");
    if (key !== undefined) {
      const existing = operations.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new ControlError({
            code: "conflict",
            message: "idempotency key was reused with different parameters"
          });
        }
        return await existing.promise;
      }
    }
    const handler = handlers[method] as (
      params: RouteKitControlParams[typeof method],
      context: ControlHandlerContext
    ) => unknown | Promise<unknown>;
    const startedAt = Date.now();
    const promise = Promise.resolve()
      .then(() => handler(validated, context))
      .then((result) => schemas.resultSchema.parse(result))
      .then(
        (result) => {
          try {
            options.onCommitted?.(method, validated, Date.now() - startedAt);
          } catch {
            /* Observers cannot affect control paths. */
          }
          return result;
        },
        (error: unknown) => {
          try {
            options.onControlError?.(
              method,
              validated,
              error instanceof ControlError ? error.code : "internal",
              Date.now() - startedAt
            );
          } catch {
            /* Observers cannot affect control paths. */
          }
          throw error;
        }
      );
    if (key === undefined) return await promise;
    const entry = { fingerprint, promise };
    operations.set(key, entry);
    try {
      const result = await promise;
      operations.complete(key, entry);
      return result;
    } catch (error) {
      operations.delete(key, entry);
      throw error;
    }
  };
}

export class RouteKitControlClient {
  readonly #client: ControlClient;

  constructor(options: ControlClientOptions) {
    this.#client = new ControlClient(options);
  }

  health(): ReturnType<ControlClient["health"]> {
    return this.#client.health();
  }

  hello(): Promise<{
    protocolVersion: string;
    product?: string;
    packageVersion?: string;
    capabilities: readonly string[];
  }> {
    return this.#client.call("hello");
  }

  call<M extends RouteKitControlMethod>(
    method: M,
    params: RouteKitControlParams[M],
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ): Promise<RouteKitControlResults[M]> {
    return this.#client.call(method, params, options);
  }
}
