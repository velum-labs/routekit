import { Cause, Effect, Exit } from "effect";
import {
  type OwnedResourceOptions,
  type ResourceFinalizer,
  ResourceDisposalTimeoutError,
  type ResourceScopeOptions
} from "./resource-scope.js";
import type { RouteKitPlatform } from "../effect/effect-runtime.js";
import { toRouteKitFailure } from "../effect/errors.js";

type EffectEntry = {
  readonly finalize: Effect.Effect<void, unknown, RouteKitPlatform>;
};

function asEffectFinalizer(value: unknown): Effect.Effect<void, unknown, RouteKitPlatform> {
  if (Effect.isEffect(value)) {
    return (value as Effect.Effect<unknown, unknown, RouteKitPlatform>).pipe(Effect.asVoid);
  }
  return Effect.tryPromise({
    try: async () => {
      await value;
    },
    catch: (cause) => toRouteKitFailure(cause)
  });
}

function defaultFinalizer<T>(resource: T): Effect.Effect<void, unknown, RouteKitPlatform> {
  const candidate = resource as {
    close?: () => unknown;
    dispose?: () => unknown;
    [Symbol.asyncDispose]?: () => Promise<void>;
    [Symbol.dispose]?: () => void;
  };
  if (typeof candidate.close === "function") {
    const close = candidate.close.bind(candidate);
    return Effect.suspend(() => asEffectFinalizer(close()));
  }
  if (typeof candidate.dispose === "function") {
    const dispose = candidate.dispose.bind(candidate);
    return Effect.suspend(() => asEffectFinalizer(dispose()));
  }
  const asyncDispose = candidate[Symbol.asyncDispose];
  if (typeof asyncDispose === "function") {
    return Effect.suspend(() => asEffectFinalizer(asyncDispose.call(candidate)));
  }
  if (typeof candidate[Symbol.dispose] === "function") {
    return Effect.try({
      try: () => {
        candidate[Symbol.dispose]!();
      },
      catch: (cause) => toRouteKitFailure(cause)
    });
  }
  throw new TypeError("owned resource requires a finalizer, close(), or dispose()");
}

function promiseFinalizer(finalizer: ResourceFinalizer): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await finalizer();
    },
    catch: (cause) => toRouteKitFailure(cause)
  });
}

function validateBudget(budgetMs: number | undefined): void {
  if (budgetMs !== undefined && (!Number.isFinite(budgetMs) || budgetMs < 0)) {
    throw new RangeError("shutdown budget must be a non-negative finite number");
  }
}

/**
 * Effect-native LIFO resource scope.
 *
 * Ownership transfer, borrowed resources, shutdown budgets, and "attempt every
 * finalizer" semantics match Promise `ResourceScope`. Effect.Scope is not a
 * substitute: startup still has to publish into a longer-lived scope without
 * rolling back already-published resources.
 *
 * `own` prefers an Effect-returning `close()`/`dispose()` so coordinators are
 * not hopped through `[Symbol.asyncDispose]`. Promise finalizers stay an
 * adapter for Node listen/close edges.
 */
export class EffectResourceScope {
  readonly #shutdownBudgetMs: number | undefined;
  #entries: EffectEntry[] = [];
  #dispose: Effect.Effect<void, unknown, RouteKitPlatform> | undefined;
  #sealed = false;

  constructor(options: ResourceScopeOptions = {}) {
    validateBudget(options.shutdownBudgetMs);
    this.#shutdownBudgetMs = options.shutdownBudgetMs;
  }

  own<T>(
    resource: T,
    options: OwnedResourceOptions<T> & {
      finalizeEffect?: (resource: T) => Effect.Effect<void, unknown, RouteKitPlatform>;
    } = {}
  ): Effect.Effect<T, Error> {
    const self = this;
    return Effect.try({
      try: () => {
        self.#assertOpen();
        const finalize =
          options.finalizeEffect !== undefined
            ? options.finalizeEffect(resource)
            : options.finalize === undefined
              ? defaultFinalizer(resource)
              : asEffectFinalizer(options.finalize(resource));
        self.#entries.push({ finalize });
        return resource;
      },
      catch: (cause) => toRouteKitFailure(cause)
    });
  }

  borrow<T>(resource: T): Effect.Effect<T, Error> {
    const self = this;
    return Effect.try({
      try: () => {
        self.#assertOpen();
        return resource;
      },
      catch: (cause) => toRouteKitFailure(cause)
    });
  }

  defer(finalizer: ResourceFinalizer): Effect.Effect<void, Error> {
    return this.deferEffect(promiseFinalizer(finalizer));
  }

  deferEffect(
    finalizer: Effect.Effect<void, unknown, RouteKitPlatform>
  ): Effect.Effect<void, Error> {
    const self = this;
    return Effect.try({
      try: () => {
        self.#assertOpen();
        self.#entries.push({ finalize: finalizer });
      },
      catch: (cause) => toRouteKitFailure(cause)
    });
  }

  transferTo(target: EffectResourceScope): Effect.Effect<void, Error> {
    const self = this;
    return Effect.try({
      try: () => {
        self.#assertOpen();
        target.#accept(self.#entries);
        self.#entries = [];
        self.#sealed = true;
      },
      catch: (cause) => toRouteKitFailure(cause)
    });
  }

  releaseAll(): Effect.Effect<void, Error> {
    const self = this;
    return Effect.try({
      try: () => {
        self.#assertOpen();
        self.#entries = [];
        self.#sealed = true;
      },
      catch: (cause) => toRouteKitFailure(cause)
    });
  }

  dispose(): Effect.Effect<void, unknown, RouteKitPlatform> {
    if (this.#dispose !== undefined) return this.#dispose;
    this.#sealed = true;
    const entries = this.#entries.splice(0).reverse();
    const budgetMs = this.#shutdownBudgetMs;
    const deadline = budgetMs === undefined ? undefined : Date.now() + budgetMs;
    this.#dispose = Effect.gen(function* () {
      const errors: unknown[] = [];
      for (const entry of entries) {
        const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
        const finalize =
          remaining === undefined
            ? entry.finalize
            : entry.finalize.pipe(
                Effect.timeoutOrElse({
                  duration: remaining,
                  orElse: () => Effect.fail(new ResourceDisposalTimeoutError(budgetMs!))
                })
              );
        const exit = yield* Effect.exit(finalize);
        if (Exit.isFailure(exit)) errors.push(Cause.squash(exit.cause));
      }
      if (errors.length > 0) {
        return yield* toRouteKitFailure(
          new AggregateError(errors, "one or more resource finalizers failed")
        );
      }
    });
    return this.#dispose;
  }

  #accept(entries: readonly EffectEntry[]): void {
    this.#assertOpen();
    this.#entries.push(...entries);
  }

  #assertOpen(): void {
    if (this.#sealed || this.#dispose !== undefined) {
      throw new Error("resource scope is no longer accepting resources");
    }
  }
}

export function makeEffectResourceScope(options: ResourceScopeOptions = {}): EffectResourceScope {
  return new EffectResourceScope(options);
}
