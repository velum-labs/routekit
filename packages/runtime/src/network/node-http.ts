import type { IncomingMessage, ServerResponse } from "node:http";
import { makeHandler } from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, Scope } from "effect";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";

import { type RouteKitPlatform, runRouteKitEffect } from "../effect/effect-runtime.js";

export type NodeHttpHandler = {
  handle: (request: IncomingMessage, response: ServerResponse) => void;
  close: Effect.Effect<void>;
};

/**
 * Adapt an Effect HTTP app onto a Node `request` listener via
 * `NodeHttpServer.makeHandler`. Keep `createServer` for RouteKit drain:
 * health flips to 503, new work is rejected, in-flight streams finish, then
 * the listener closes. Effect's server-scope shutdown does not match that.
 *
 * The handler scope lives for the listener lifetime so request fibers can be
 * interrupted when the client disconnects.
 */
export function createNodeHttpHandlerEffect(
  httpEffect: Effect.Effect<
    HttpServerResponse,
    unknown,
    HttpServerRequest | Scope.Scope | RouteKitPlatform
  >
): Effect.Effect<NodeHttpHandler, never, RouteKitPlatform> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const handle = yield* (
      makeHandler(httpEffect, { scope }) as Effect.Effect<
        (request: IncomingMessage, response: ServerResponse) => void,
        never,
        RouteKitPlatform | Scope.Scope
      >
    ).pipe(Effect.provideService(Scope.Scope, scope));
    return {
      handle,
      close: Scope.close(scope, Exit.void)
    };
  });
}

/** Promise adapter for hosts that construct a standalone Node listener. */
export async function createNodeHttpHandler(
  httpEffect: Effect.Effect<
    HttpServerResponse,
    unknown,
    HttpServerRequest | Scope.Scope | RouteKitPlatform
  >
): Promise<NodeHttpHandler> {
  return runRouteKitEffect(createNodeHttpHandlerEffect(httpEffect));
}
