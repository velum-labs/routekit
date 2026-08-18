import {
  buildTelemetryEvent,
  type CommandCompletedProperties,
  type TelemetryEventProperties
} from "@velum-labs/routekit-telemetry-core";
import { z } from "zod";
import type {
  ControlAuthorization,
  ControlIdempotencyPolicy,
  ControlMutationClassification
} from "./method-registry.js";
import type { RouteKitControlMethod, RouteKitControlParams } from "./protocol.js";
import {
  boundedInt,
  closedParams,
  openParams,
  requiredBoolean,
  requiredEnum,
  requiredString,
  requiredUnknown,
  typedBoolean,
  resultValue as value
} from "./schema.js";

/** Telemetry operation names the daemon reports for user-visible mutations. */
export type ProductOperation =
  TelemetryEventProperties["routekit.product_operation_completed"]["operation"];

/**
 * Everything the control plane knows about one method, declared once.
 *
 * `authorization` and `idempotency` are omitted wherever they follow from the
 * mutation classification, which is the case for every method but `daemon.roll`.
 * Reading a row therefore surfaces only what is genuinely method-specific.
 */
export type ControlMethodSurface = "cli" | "daemon" | "cli-internal";

export type ControlMethodSpec<M extends RouteKitControlMethod> = {
  /** Structural contract enforced at the protocol edge. */
  readonly params: z.ZodType<RouteKitControlParams[M]>;
  /** Shallow shape the daemon promises callers; deeper types live in `protocol.ts`. */
  readonly result: z.ZodType;
  readonly mutation: ControlMutationClassification;
  /** Defaults to `authenticated`. */
  readonly authorization?: ControlAuthorization;
  /** Defaults to `optional` for mutations and `none` for queries. */
  readonly idempotency?: ControlIdempotencyPolicy;
  /**
   * How the method is reached. Defaults to `cli`. `daemon` methods have no
   * production CLI caller; `cli-internal` is CLI plumbing without a user command.
   */
  readonly surface?: Exclude<ControlMethodSurface, "cli">;
  /** Product telemetry emitted on completion, when the method is user-visible. */
  readonly operation?: ProductOperation | ((params: RouteKitControlParams[M]) => ProductOperation);
};

const configSnapshot = { path: value.string, document: value.string, revision: value.number };
const telemetryStatus = {
  enabled: value.boolean,
  source: value.string,
  categories: value.object,
  installIdPresent: value.boolean,
  destination: value.object,
  schema: value.object
};

const ACCOUNT_KINDS = ["claude-code", "codex"] as const;
const TOKEN_PLANES = ["data", "control"] as const;
const EVAL_SESSION_PURPOSES = ["authoring", "qualification"] as const;
const routingActivation = requiredUnknown("activation") as z.ZodType<
  RouteKitControlParams["evalRouting.activate"]["activation"]
>;

/**
 * `buildTelemetryEvent` owns the command-completed allowlist, so the protocol
 * defers to it rather than restating the property set. Its rejections are
 * surfaced as ordinary parameter failures instead of leaking as `TypeError`.
 */
const commandCompletedParams = z.looseObject({}).superRefine((candidate, ctx) => {
  try {
    buildTelemetryEvent("routekit.command_completed", candidate as CommandCompletedProperties);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}) as unknown as z.ZodType<CommandCompletedProperties>;

const telemetrySetParams = z
  .strictObject({
    enabled: typedBoolean("enabled").optional(),
    category: requiredEnum("category", ["usage", "reliability", "adoption"]).optional(),
    categoryEnabled: typedBoolean("categoryEnabled").optional()
  })
  .superRefine((candidate, ctx) => {
    const touchesCategory =
      candidate.category !== undefined || candidate.categoryEnabled !== undefined;
    if (candidate.enabled === undefined && !touchesCategory) {
      ctx.addIssue({ code: "custom", message: "requires enabled or category change" });
      return;
    }
    if (!touchesCategory) return;
    if (candidate.category === undefined) {
      ctx.addIssue({ code: "custom", message: "requires category" });
    } else if (candidate.categoryEnabled === undefined) {
      ctx.addIssue({ code: "custom", message: "requires categoryEnabled" });
    }
  });

const daemonRollParams = z
  .strictObject({
    reason: requiredEnum("reason", ["restart", "upgrade"]),
    expectedGeneration: boundedInt(0, "expectedGeneration must be a non-negative safe integer"),
    candidate: z
      .strictObject({
        binPath: requiredString("binPath"),
        expectedVersion: requiredString("expectedVersion")
      })
      .optional()
  })
  .superRefine((candidate, ctx) => {
    if (candidate.reason === "upgrade" && candidate.candidate === undefined) {
      ctx.addIssue({ code: "custom", message: "upgrade requires a candidate" });
    }
  });

type ControlMethodTable = { readonly [M in RouteKitControlMethod]: ControlMethodSpec<M> };

/**
 * The control plane's single source of truth. Method names are the keys of
 * `RouteKitControlParams`; this table must cover every one. Parameter and
 * result contracts, authorization, mutation classification, idempotency
 * policy, CLI surface, and product telemetry are all read from here; nothing
 * downstream re-declares a method list.
 */
export const CONTROL_METHODS = {
  "daemon.status": {
    params: openParams,
    result: z.looseObject({
      pid: value.number,
      packageVersion: value.string,
      protocolVersion: value.string
    }),
    mutation: "query"
  },
  "daemon.reload": {
    params: z.looseObject({ expectedRevision: z.number().optional() }),
    result: z.looseObject({
      reloaded: value.true,
      configRevision: value.number,
      accountRevision: value.number
    }),
    mutation: "mutation",
    operation: "config_reload"
  },
  "daemon.roll": {
    params: daemonRollParams,
    result: z.looseObject({
      rolled: value.true,
      reason: value.string,
      generation: value.number
    }),
    mutation: "mutation",
    authorization: "ephemeral"
  },
  "daemon.prepareShutdown": {
    params: z.looseObject({ reason: requiredEnum("reason", ["stop", "restart", "upgrade"]) }),
    result: z.looseObject({ accepted: value.true }),
    mutation: "mutation"
  },
  "config.get": {
    params: openParams,
    result: z.looseObject(configSnapshot),
    mutation: "query"
  },
  "config.update": {
    params: z.looseObject({
      expectedRevision: boundedInt(0, "requires a non-negative expectedRevision"),
      document: requiredString("document")
    }),
    result: z.looseObject(configSnapshot),
    mutation: "mutation",
    operation: "config_update"
  },
  "config.import": {
    params: z.looseObject({
      expectedRevision: boundedInt(0, "requires a non-negative expectedRevision"),
      document: requiredString("document"),
      source: z.string().optional()
    }),
    result: z.looseObject(configSnapshot),
    mutation: "mutation",
    operation: "config_import"
  },
  "providers.status": {
    params: z.looseObject({ live: z.boolean().optional() }),
    result: z.looseObject({ providers: value.array }),
    mutation: "query"
  },
  "providers.set": {
    params: z.looseObject({
      provider: requiredString("provider"),
      enabled: requiredBoolean("enabled"),
      idempotencyKey: z.string().optional()
    }),
    result: z.looseObject(configSnapshot),
    mutation: "mutation",
    operation: (params) => (params.enabled ? "provider_enable" : "provider_disable"),
    surface: "daemon"
  },
  "models.list": {
    params: z.looseObject({
      provider: z.string().optional(),
      refresh: z.boolean().optional()
    }),
    result: z.looseObject({ models: value.array, revision: value.number }),
    mutation: "query"
  },
  "models.info": {
    params: z.looseObject({ model: requiredString("model") }),
    result: z.looseObject({
      id: value.string,
      provider: value.string,
      nativeModel: value.string,
      accountClass: value.string,
      billingMode: value.string,
      default: value.boolean,
      capabilities: value.object
    }),
    mutation: "query"
  },
  "calls.inspect": {
    params: z.looseObject({ callId: requiredString("callId") }),
    result: z.looseObject({
      callId: value.string,
      status: value.string,
      effectiveModel: value.string,
      provider: value.string,
      retries: value.object,
      cost: value.object,
      timing: value.object
    }),
    mutation: "query"
  },
  "calls.leaderboard": {
    params: z.looseObject({
      by: requiredEnum("by", ["principal", "model", "provider"]).optional(),
      sort: requiredEnum("sort", ["cost", "requests", "tokens", "errors", "latency"]).optional(),
      limit: boundedInt(1, "limit must be a positive integer").optional(),
      window: requiredEnum("window", ["live", "1h", "24h", "7d"]).optional()
    }),
    result: z.looseObject({
      by: value.string,
      sort: value.string,
      rows: value.array,
      budget: value.object
    }),
    mutation: "query"
  },
  "accounts.list": {
    params: openParams,
    result: z.looseObject({ accounts: value.array, revision: value.number }),
    mutation: "query"
  },
  "accounts.status": {
    params: openParams,
    result: z.looseObject({
      accounts: value.array,
      revision: value.number,
      recovery: value.object
    }),
    mutation: "query"
  },
  "accounts.enroll": {
    params: z.looseObject({
      kind: requiredEnum("kind", ACCOUNT_KINDS),
      label: requiredString("label"),
      credential: requiredUnknown("credential")
    }),
    result: z.looseObject({ enrolled: value.true, revision: value.number }),
    mutation: "mutation",
    operation: "account_enroll",
    surface: "daemon"
  },
  "accounts.enrollActivate": {
    params: z.looseObject({
      kind: requiredString("kind"),
      accounts: z
        .array(
          z.looseObject({ label: requiredString("label"), credential: z.unknown().optional() }),
          {
            error: "requires one or more accounts"
          }
        )
        .min(1, { error: "requires one or more accounts" })
    }),
    result: z.looseObject({
      enrolled: value.array,
      activated: value.true,
      configPath: value.string,
      configRevision: value.number,
      accountRevision: value.number
    }),
    mutation: "mutation",
    operation: "account_enroll_activate"
  },
  "accounts.remove": {
    params: z.looseObject({ kind: requiredString("kind"), label: requiredString("label") }),
    result: z.looseObject({ removed: value.boolean, revision: value.number }),
    mutation: "mutation",
    operation: "account_remove"
  },
  "accounts.rename": {
    params: z.looseObject({
      kind: requiredEnum("kind", ACCOUNT_KINDS),
      source: requiredString("source"),
      target: requiredString("target")
    }),
    result: z.looseObject({ renamed: value.true, revision: value.number }),
    mutation: "mutation"
  },
  "accounts.sync": {
    params: openParams,
    result: z.looseObject({ synced: value.true, revision: value.number }),
    mutation: "mutation",
    operation: "account_sync",
    surface: "daemon"
  },
  "accounts.usage": {
    params: openParams,
    result: z.looseObject({ accountSets: value.array }),
    mutation: "query"
  },
  "accounts.resetCredits": {
    params: z.looseObject({
      kind: requiredEnum("kind", ["codex"]),
      label: requiredString("label")
    }),
    result: z.looseObject({
      kind: value.string,
      label: value.string,
      resetCredits: value.object
    }),
    mutation: "query"
  },
  "accounts.redeemReset": {
    params: z.looseObject({
      kind: requiredEnum("kind", ["codex"]),
      label: requiredString("label"),
      creditId: requiredString("creditId").optional(),
      redeemRequestId: requiredString("redeemRequestId").optional()
    }),
    result: z.looseObject({
      ok: value.boolean,
      code: value.string,
      kind: value.string,
      label: value.string,
      redeemRequestId: value.string,
      usage: value.object
    }),
    mutation: "mutation"
  },
  "telemetry.get": {
    params: closedParams,
    result: z.looseObject(telemetryStatus),
    mutation: "query"
  },
  "telemetry.set": {
    params: telemetrySetParams,
    result: z.looseObject(telemetryStatus),
    mutation: "mutation"
  },
  "telemetry.resetIdentity": {
    params: closedParams,
    result: z.looseObject(telemetryStatus),
    mutation: "mutation"
  },
  "telemetry.schema": {
    params: closedParams,
    result: z.looseObject({}),
    mutation: "query"
  },
  "telemetry.captureCommand": {
    params: commandCompletedParams,
    result: z.looseObject({ accepted: value.boolean }),
    mutation: "query",
    surface: "cli-internal"
  },
  "doctor.run": {
    params: openParams,
    result: z.looseObject({ checks: value.array }),
    mutation: "query"
  },
  "launcher.prepare": {
    params: z.looseObject({
      tool: requiredEnum("tool", ["codex", "claude", "cursor", "opencode"]),
      model: z.string().optional(),
      cwd: z.string().optional()
    }),
    result: z.looseObject({
      tool: value.string,
      model: value.string,
      gatewayUrl: value.string,
      env: value.object
    }),
    mutation: "query",
    operation: "launcher_prepare"
  },
  "tokens.issue": {
    params: z.looseObject({
      label: requiredString("label"),
      plane: requiredEnum("plane", TOKEN_PLANES),
      createdBy: z.string().optional()
    }),
    result: z.looseObject({
      id: value.string,
      label: value.string,
      plane: value.string,
      role: value.string,
      token: value.string
    }),
    mutation: "mutation",
    operation: "token_issue"
  },
  "tokens.list": {
    params: z.looseObject({ plane: requiredEnum("plane", TOKEN_PLANES).optional() }),
    result: z.looseObject({ tokens: value.array }),
    mutation: "query"
  },
  "tokens.revoke": {
    params: z.looseObject({ id: requiredString("id") }),
    result: z.looseObject({
      id: value.string,
      label: value.string,
      plane: value.string,
      role: value.string,
      createdAt: value.string
    }),
    mutation: "mutation",
    operation: "token_revoke"
  },
  "evalSession.open": {
    params: z
      .strictObject({
        purpose: requiredEnum("purpose", EVAL_SESSION_PURPOSES),
        operationId: requiredString("operationId").max(128),
        allowedModels: z
          .array(requiredString("allowedModels").max(256))
          .min(1)
          .max(64)
          .superRefine((models, ctx) => {
            if (new Set(models).size !== models.length) {
              ctx.addIssue({ code: "custom", message: "allowedModels contains duplicates" });
            }
            for (const [index, model] of models.entries()) {
              if (!model.includes("/") || model.trim().toLowerCase() === "auto") {
                ctx.addIssue({
                  code: "custom",
                  path: [index],
                  message: "allowedModels must contain explicit provider/model ids"
                });
              }
            }
          }),
        limits: z.strictObject({
          calls: boundedInt(1, "calls must be a positive safe integer"),
          inputTokens: boundedInt(1, "inputTokens must be a positive safe integer"),
          outputTokens: boundedInt(1, "outputTokens must be a positive safe integer"),
          perCallOutputTokens: boundedInt(1, "perCallOutputTokens must be a positive safe integer"),
          wallTimeMs: boundedInt(1, "wallTimeMs must be a positive safe integer")
        }),
        expiresInSeconds: boundedInt(
          1,
          "expiresInSeconds must be between 1 and 14400"
        ).max(14_400, {
          error: "expiresInSeconds must be between 1 and 14400"
        })
      })
      .superRefine((params, ctx) => {
        if (params.limits.perCallOutputTokens > params.limits.outputTokens) {
          ctx.addIssue({
            code: "custom",
            path: ["limits", "perCallOutputTokens"],
            message: "perCallOutputTokens cannot exceed outputTokens"
          });
        }
      }),
    result: z.strictObject({
      sessionId: value.string,
      gatewayUrl: value.string,
      bearerCredential: value.string,
      targetIdentity: value.string,
      expiresAt: value.string
    }),
    mutation: "mutation",
    idempotency: "required",
    surface: "cli-internal"
  },
  "evalSession.close": {
    params: z.strictObject({ sessionId: requiredString("sessionId") }),
    result: z.strictObject({ sessionId: value.string, closed: value.boolean }),
    mutation: "mutation",
    idempotency: "required",
    surface: "cli-internal"
  },
  "evalRouting.status": {
    params: closedParams,
    result: z.strictObject({ activation: routingActivation.nullable() }),
    mutation: "query",
    surface: "cli-internal"
  },
  "evalRouting.activate": {
    params: z.strictObject({
      expectedEvidenceDigest: requiredString("expectedEvidenceDigest").nullable(),
      activation: routingActivation
    }),
    result: z.strictObject({
      activated: value.true,
      activation: routingActivation
    }),
    mutation: "mutation",
    idempotency: "required",
    surface: "cli-internal"
  }
} as const satisfies ControlMethodTable;

const TABLE: ControlMethodTable = CONTROL_METHODS;

export const ROUTEKIT_CONTROL_METHODS = Object.keys(CONTROL_METHODS) as RouteKitControlMethod[];

/** Idempotency policy for a method, including defaults derived from mutation class. */
export type ControlMethodIdempotency<M extends RouteKitControlMethod> =
  (typeof CONTROL_METHODS)[M] extends {
    readonly idempotency: infer I extends ControlIdempotencyPolicy;
  }
    ? I
    : (typeof CONTROL_METHODS)[M]["mutation"] extends "mutation"
      ? "optional"
      : "none";

/** Call options the product client accepts for one method. */
export type RouteKitCallOptions<M extends RouteKitControlMethod> = {
  signal?: AbortSignal;
} & (ControlMethodIdempotency<M> extends "required"
  ? { idempotencyKey: string }
  : ControlMethodIdempotency<M> extends "optional"
    ? { idempotencyKey?: string }
    : { idempotencyKey?: never });

export function controlMethodSpec<M extends RouteKitControlMethod>(
  method: M
): ControlMethodSpec<M> {
  return TABLE[method];
}

export function isRouteKitControlMethod(method: string): method is RouteKitControlMethod {
  return Object.hasOwn(CONTROL_METHODS, method);
}

export function controlAuthorization(method: RouteKitControlMethod): ControlAuthorization {
  return TABLE[method].authorization ?? "authenticated";
}

export function controlMutation(method: RouteKitControlMethod): ControlMutationClassification {
  return TABLE[method].mutation;
}

/** How callers reach a method. Defaults to user-facing CLI. */
export function controlSurface(method: RouteKitControlMethod): ControlMethodSurface {
  return TABLE[method].surface ?? "cli";
}

export function controlIdempotency(method: RouteKitControlMethod): ControlIdempotencyPolicy {
  const spec = TABLE[method];
  return spec.idempotency ?? (spec.mutation === "mutation" ? "optional" : "none");
}

/** Product telemetry operation for a completed call, when one is reported. */
export function controlOperation(
  method: RouteKitControlMethod,
  params: unknown
): ProductOperation | undefined {
  const operation = TABLE[method].operation;
  if (operation === undefined) return undefined;
  if (typeof operation !== "function") return operation;
  return (operation as (value: unknown) => ProductOperation)(params);
}
