import { AsyncLocalStorage } from "node:async_hooks";

import type { CliRuntime } from "@velum-labs/routekit-cli-core";
import type { RouteKitControlClient } from "@velum-labs/routekit-control";
import {
  makeRouteKitRuntime,
  type RouteKitManagedRuntime,
  type RouteKitPlatform,
  runRouteKitEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import type { RemoteStores } from "./remote-stores.js";
import { createRemoteStores } from "./remote-stores.js";

export type TargetSelection = { local: boolean; remote?: string };
export type ResolvedTelemetryTarget = {
  client: RouteKitControlClient;
  kind: "local" | "remote" | "peer";
};

export class CliSession {
  targetSelection: TargetSelection = { local: false };
  telemetryTarget: ResolvedTelemetryTarget | undefined;
  readonly remotes: RemoteStores;
  #effectRuntime: RouteKitManagedRuntime | undefined;

  constructor(
    readonly runtime: CliRuntime,
    remotes: RemoteStores = createRemoteStores()
  ) {
    this.remotes = remotes;
  }

  /** Process-lifetime Effect runtime for this CLI invocation. */
  get effectRuntime(): RouteKitManagedRuntime {
    this.#effectRuntime ??= makeRouteKitRuntime();
    return this.#effectRuntime;
  }

  async dispose(): Promise<void> {
    if (this.#effectRuntime === undefined) return;
    await this.#effectRuntime.dispose();
    this.#effectRuntime = undefined;
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
export function runCliEffect<A, E, R extends RouteKitPlatform = RouteKitPlatform>(
  effect: Effect.Effect<A, E, R>
): Promise<A> {
  const session = invocationStorage.getStore();
  if (session === undefined) return runRouteKitEffect(effect);
  return runRouteKitEffect(effect, session.effectRuntime);
}

/** Run a synchronous CLI step as an Effect, preserving Error subclasses. */
export function cliTry<A>(run: () => A): Effect.Effect<A, Error> {
  return Effect.try({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : toRouteKitFailure(cause))
  });
}

/** Run an asynchronous CLI step as an Effect, preserving Error subclasses. */
export function cliTryPromise<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : toRouteKitFailure(cause))
  });
}
