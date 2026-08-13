import type { ControlHandlerContext } from "@velum-labs/routekit-runtime";
import {
  type RouteKitManagedRuntime,
  type RouteKitPlatform,
  routeKitError,
  withAbortSignal
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import type {
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams,
  RouteKitControlResults
} from "../protocol.js";

export type EffectRouteKitMethodHandler<M extends RouteKitControlMethod> = (
  params: RouteKitControlParams[M],
  context: ControlHandlerContext
) => Effect.Effect<RouteKitControlResults[M], Error, RouteKitPlatform>;

export type EffectRouteKitControlHandlers = {
  [M in RouteKitControlMethod]: EffectRouteKitMethodHandler<M>;
};

/** Lift Promise `control.v2` handlers into Effect so a process runtime can run them. */
export function fromPromiseControlHandlers(
  handlers: RouteKitControlHandlers
): EffectRouteKitControlHandlers {
  return new Proxy(handlers, {
    get(target, method, receiver) {
      const handler = Reflect.get(target, method, receiver);
      if (typeof handler !== "function") return handler;
      return (params: unknown, context: ControlHandlerContext) =>
        Effect.tryPromise({
          try: () => Promise.resolve(handler(params, context)),
          catch: (cause) => routeKitError(cause)
        });
    }
  }) as unknown as EffectRouteKitControlHandlers;
}

/**
 * Adapt Effect control handlers to the `control.v2` wire.
 *
 * Wire schemas, idempotency, and method names stay unchanged. Caller cancel
 * interrupts only this handler run. Pass the process `ManagedRuntime`.
 */
export function toPromiseControlHandlers(
  handlers: EffectRouteKitControlHandlers,
  runtime: RouteKitManagedRuntime
): RouteKitControlHandlers {
  return new Proxy(handlers, {
    get(target, method, receiver) {
      const handler = Reflect.get(target, method, receiver) as
        | EffectRouteKitMethodHandler<RouteKitControlMethod>
        | undefined;
      if (typeof handler !== "function") return handler;
      return (
        params: RouteKitControlParams[RouteKitControlMethod],
        context: ControlHandlerContext
      ) => runtime.runPromise(withAbortSignal(handler(params, context), context.signal));
    }
  }) as unknown as RouteKitControlHandlers;
}
