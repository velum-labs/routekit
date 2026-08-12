import { createHash } from "node:crypto";
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
import { IdempotencyStore } from "./idempotency-store.js";
import type { ControlMethodRegistry, ControlSchema } from "./method-registry.js";
import {
  CONTROL_METHODS,
  controlMutation,
  isRouteKitControlMethod,
  ROUTEKIT_CONTROL_METHODS
} from "./method-table.js";
import type {
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams,
  RouteKitControlResults
} from "./protocol.js";
import { paramsValidator, resultValidator } from "./schema.js";

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
export type { ControlMethodSpec, ProductOperation } from "./method-table.js";
export {
  CONTROL_METHODS,
  controlAuthorization,
  controlIdempotency,
  controlMutation,
  controlOperation,
  isRouteKitControlMethod,
  ROUTEKIT_CONTROL_METHODS
} from "./method-table.js";
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

type MethodSchemas = {
  [M in RouteKitControlMethod]: {
    paramsSchema: ControlSchema<RouteKitControlParams[M]>;
    resultSchema: ControlSchema<RouteKitControlResults[M]>;
  };
};

const SCHEMAS = Object.fromEntries(
  ROUTEKIT_CONTROL_METHODS.map((method) => [
    method,
    {
      paramsSchema: paramsValidator(method, CONTROL_METHODS[method].params),
      resultSchema: resultValidator(method, CONTROL_METHODS[method].result)
    }
  ])
) as MethodSchemas;

/** Methods whose completion changes daemon state, derived from the method table. */
export const MUTATING_ROUTEKIT_METHODS: ReadonlySet<RouteKitControlMethod> = new Set(
  ROUTEKIT_CONTROL_METHODS.filter((method) => controlMutation(method) === "mutation")
);

export function routeKitControlSchemas<M extends RouteKitControlMethod>(
  method: M
): MethodSchemas[M] {
  const schemas = SCHEMAS[method];
  if (schemas === undefined) {
    throw new ControlError({
      code: "not_found",
      message: `unknown RouteKit control method: ${method}`
    });
  }
  return schemas;
}

/**
 * Validate method-specific structural invariants at the protocol edge. Domain
 * parsers perform deeper validation (provider ids, router schema, credentials).
 */
export function validateRouteKitParams<M extends RouteKitControlMethod>(
  method: M,
  value: unknown
): RouteKitControlParams[M] {
  return routeKitControlSchemas(method).paramsSchema.parse(value);
}

export function validateRouteKitResult<M extends RouteKitControlMethod>(
  method: M,
  value: unknown
): RouteKitControlResults[M] {
  return routeKitControlSchemas(method).resultSchema.parse(value);
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
    if (!isRouteKitControlMethod(rawMethod)) {
      throw new ControlError({
        code: "not_found",
        message: `unknown RouteKit control method: ${rawMethod}`
      });
    }
    const method = rawMethod;
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
