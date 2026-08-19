import { AsyncLocalStorage } from "node:async_hooks";

import type { CliRuntime } from "@velum-labs/routekit-cli-core";
import type { RouteKitControlClient } from "@velum-labs/routekit-control";
import {
  makeRouteKitRuntime,
  RouteKitFailure,
  type RouteKitManagedRuntime,
  runRouteKitEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { RemoteStores } from "./repositories/stores.js";
import { createRemoteStores } from "./repositories/stores.js";

export type TargetSelection = { local: boolean; remote?: string };
export type ResolvedTelemetryTarget = {
  client: RouteKitControlClient;
  kind: "local" | "remote" | "peer";
};

export class CliSession {
  targetSelection: TargetSelection = { local: false };
  telemetryTarget: ResolvedTelemetryTarget | undefined;
  readonly remotes: RemoteStores;
  readonly effectRuntime: RouteKitManagedRuntime;
  readonly #ownsEffectRuntime: boolean;

  constructor(
    readonly runtime: CliRuntime,
    remotes: RemoteStores = createRemoteStores(),
    effectRuntime?: RouteKitManagedRuntime
  ) {
    this.remotes = remotes;
    this.effectRuntime = effectRuntime ?? makeRouteKitRuntime();
    this.#ownsEffectRuntime = effectRuntime === undefined;
  }

  async dispose(): Promise<void> {
    if (this.#ownsEffectRuntime) await this.effectRuntime.dispose();
  }
}

const invocationStorage = new AsyncLocalStorage<CliSession>();

export function runWithCliSession<T>(session: CliSession, run: () => T): T {
  return invocationStorage.run(session, run);
}

export function activeCliSession(): CliSession {
  const session = invocationStorage.getStore();
  if (session === undefined) {
    throw new Error("RouteKit CLI invocation context is unavailable");
  }
  return session;
}

/** Run an Effect program on this CLI invocation's process runtime. */
export function runCliEffect<A, E, R = never>(effect: Effect.Effect<A, E, R>): Promise<A> {
  const session = invocationStorage.getStore();
  if (session === undefined) return runRouteKitEffect(effect);
  return runRouteKitEffect(effect, session.effectRuntime);
}

/** Run a synchronous CLI step as an Effect, tagging failures. */
export function cliTry<A>(run: () => A): Effect.Effect<A, RouteKitFailure> {
  return Effect.try({
    try: run,
    catch: (cause) => toRouteKitFailure(cause)
  });
}

/** Run an asynchronous CLI step as an Effect, tagging failures. */
export function cliTryPromise<A>(run: () => Promise<A>): Effect.Effect<A, RouteKitFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toRouteKitFailure(cause)
  });
}

/** Construct a typed CLI failure for direct `yield*` from command programs. */
export function cliFailure(message: string): RouteKitFailure {
  return new RouteKitFailure({ message });
}
