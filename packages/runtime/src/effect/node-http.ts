import type { IncomingMessage, ServerResponse } from "node:http";
import { makeHandler } from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, Scope } from "effect";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";

import { type RouteKitManagedRuntime, runRouteKitEffect } from "./effect-runtime.js";

export type NodeHttpHandler = {
  handle: (request: IncomingMessage, response: ServerResponse) => void;
  close: () => Promise<void>;
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
export async function createNodeHttpHandler(
  httpEffect: Effect.Effect<HttpServerResponse, unknown, HttpServerRequest | Scope.Scope>,
  runtime?: RouteKitManagedRuntime
): Promise<NodeHttpHandler> {
  const scope = await runRouteKitEffect(Scope.make(), runtime);
  const handle = await runRouteKitEffect(
    makeHandler(httpEffect, { scope }) as Effect.Effect<
      (request: IncomingMessage, response: ServerResponse) => void
    >,
    runtime
  );
  return {
    handle,
    close: async () => {
      await runRouteKitEffect(Scope.close(scope, Exit.void), runtime);
    }
  };
}
