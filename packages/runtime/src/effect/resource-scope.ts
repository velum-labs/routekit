import { Cause, Effect, Exit } from "effect";
import {
  type OwnedResourceOptions,
  type ResourceFinalizer,
  ResourceDisposalTimeoutError,
  type ResourceScopeOptions
} from "../resource-scope.js";
import { toRouteKitFailure } from "./errors.js";

type EffectEntry = {
  readonly finalize: Effect.Effect<void, unknown>;
};

function defaultFinalizer<T>(resource: T): ResourceFinalizer {
  const candidate = resource as {
    close?: () => void | Promise<void>;
    dispose?: () => void | Promise<void>;
    [Symbol.asyncDispose]?: () => Promise<void>;
    [Symbol.dispose]?: () => void;
  };
  if (typeof candidate[Symbol.asyncDispose] === "function") {
    return async () => await candidate[Symbol.asyncDispose]!();
  }
  if (typeof candidate[Symbol.dispose] === "function") {
    return () => candidate[Symbol.dispose]!();
  }
  if (typeof candidate.close === "function") {
    return async () => await candidate.close!();
  }
  if (typeof candidate.dispose === "function") {
    return async () => await candidate.dispose!();
  }
  throw new TypeError("owned resource requires a finalizer, close(), or dispose()");
}

function asEffectFinalizer(finalizer: ResourceFinalizer): Effect.Effect<void, unknown> {
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
 */
export class EffectResourceScope {
  readonly #shutdownBudgetMs: number | undefined;
  #entries: EffectEntry[] = [];
  #dispose: Effect.Effect<void, unknown> | undefined;
  #sealed = false;

  constructor(options: ResourceScopeOptions = {}) {
    validateBudget(options.shutdownBudgetMs);
    this.#shutdownBudgetMs = options.shutdownBudgetMs;
  }

  own<T>(resource: T, options: OwnedResourceOptions<T> = {}): Effect.Effect<T, Error> {
    const self = this;
    return Effect.try({
      try: () => {
        self.#assertOpen();
        const finalize =
          options.finalize === undefined
            ? defaultFinalizer(resource)
            : async () => await options.finalize!(resource);
        self.#entries.push({ finalize: asEffectFinalizer(finalize) });
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
    return this.deferEffect(asEffectFinalizer(finalizer));
  }

  deferEffect(finalizer: Effect.Effect<void, unknown>): Effect.Effect<void, Error> {
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

  dispose(): Effect.Effect<void, unknown> {
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
