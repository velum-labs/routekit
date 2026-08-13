import { Effect } from "effect";
import {
  type OwnedResourceOptions,
  type ResourceFinalizer,
  ResourceScope,
  type ResourceScopeOptions
} from "../resource-scope.js";
import { routeKitError } from "./errors.js";

/**
 * Effect façade over RouteKit's LIFO resource scope.
 *
 * Ownership transfer, borrowed resources, shutdown budgets, and "attempt every
 * finalizer" semantics stay on the existing implementation. Effect.Scope is not
 * a substitute: startup still has to publish into a longer-lived scope without
 * rolling back already-published resources.
 */
export class EffectResourceScope {
  readonly #scope: ResourceScope;

  constructor(options: ResourceScopeOptions = {}) {
    this.#scope = new ResourceScope(options);
  }

  own<T>(resource: T, options: OwnedResourceOptions<T> = {}): Effect.Effect<T, Error> {
    return Effect.try({
      try: () => this.#scope.own(resource, options),
      catch: (cause) => routeKitError(cause)
    });
  }

  borrow<T>(resource: T): Effect.Effect<T, Error> {
    return Effect.try({
      try: () => this.#scope.borrow(resource),
      catch: (cause) => routeKitError(cause)
    });
  }

  defer(finalizer: ResourceFinalizer): Effect.Effect<void, Error> {
    return Effect.try({
      try: () => this.#scope.defer(finalizer),
      catch: (cause) => routeKitError(cause)
    });
  }

  deferEffect(finalizer: Effect.Effect<void, unknown>): Effect.Effect<void, Error> {
    return this.defer(async () => {
      await Effect.runPromise(finalizer);
    });
  }

  transferTo(target: EffectResourceScope): Effect.Effect<void, Error> {
    return Effect.try({
      try: () => this.#scope.transferTo(target.#scope),
      catch: (cause) => routeKitError(cause)
    });
  }

  releaseAll(): Effect.Effect<void, Error> {
    return Effect.try({
      try: () => this.#scope.releaseAll(),
      catch: (cause) => routeKitError(cause)
    });
  }

  dispose(): Effect.Effect<void, unknown> {
    return Effect.tryPromise({
      try: () => this.#scope.dispose(),
      catch: (cause) => cause
    });
  }
}

export function makeEffectResourceScope(options: ResourceScopeOptions = {}): EffectResourceScope {
  return new EffectResourceScope(options);
}
