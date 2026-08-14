import type { ControlHandlerContext } from "@velum-labs/routekit-runtime";
import {
  type RouteKitManagedRuntime,
  type RouteKitPlatform,
  runRouteKitEffect,
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
      ) => runRouteKitEffect(withAbortSignal(handler(params, context), context.signal), runtime);
    }
  }) as unknown as RouteKitControlHandlers;
}
