import {
  type RouteKitManagedRuntime,
  withAbortSignal
} from "@velum-labs/routekit-runtime/effect";
import type { ControlHandlerContext } from "@velum-labs/routekit-runtime";
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
) => Effect.Effect<RouteKitControlResults[M], Error>;

export type EffectRouteKitControlHandlers = {
  [M in RouteKitControlMethod]: EffectRouteKitMethodHandler<M>;
};

/**
 * Adapt Effect control handlers to the existing Promise `control.v2` façade.
 *
 * Wire schemas, idempotency, and method names stay unchanged. Caller cancel
 * interrupts only this handler run.
 */
export function toPromiseControlHandlers(
  handlers: EffectRouteKitControlHandlers,
  runtime?: RouteKitManagedRuntime
): RouteKitControlHandlers {
  const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    if (runtime !== undefined) return await runtime.runPromise(effect);
    return await Effect.runPromise(effect);
  };
  return new Proxy(handlers, {
    get(target, method, receiver) {
      const handler = Reflect.get(target, method, receiver) as
        | EffectRouteKitMethodHandler<RouteKitControlMethod>
        | undefined;
      if (typeof handler !== "function") return handler;
      return (params: RouteKitControlParams[RouteKitControlMethod], context: ControlHandlerContext) =>
        run(withAbortSignal(handler(params, context), context.signal));
    }
  }) as unknown as RouteKitControlHandlers;
}
