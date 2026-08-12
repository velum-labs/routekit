import { AsyncLocalStorage } from "node:async_hooks";

import type { CliRuntime } from "@velum-labs/routekit-cli-core";
import type { RouteKitControlClient } from "@velum-labs/routekit-control";

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

  constructor(
    readonly runtime: CliRuntime,
    remotes: RemoteStores = createRemoteStores()
  ) {
    this.remotes = remotes;
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
