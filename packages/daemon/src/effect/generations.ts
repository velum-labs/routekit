import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  createDaemonGenerationManager,
  type DaemonGenerationManager,
  type DaemonGenerationManagerOptions,
  type DaemonGenerationMutation
} from "../daemon-generations.js";
import type { RouterConfig } from "@velum-labs/routekit-config";
import type { RunningRouter } from "@velum-labs/routekit-router";

/**
 * Effect façade over the explicit prepare/validate/persist/commit/retire
 * generation transaction. Do not replace this with `ScopedRef` alone:
 * pre-publication stages roll back, and post-publication retirement is
 * best-effort.
 */
export class EffectDaemonGenerationManager {
  readonly #inner: DaemonGenerationManager;

  constructor(inner: DaemonGenerationManager) {
    this.#inner = inner;
  }

  get inner(): DaemonGenerationManager {
    return this.#inner;
  }

  start(config: RouterConfig): Effect.Effect<RunningRouter, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.start(config),
      catch: (cause) => routeKitError(cause)
    });
  }

  replace(
    nextConfig: RouterConfig,
    nextDocument: string,
    mutation: DaemonGenerationMutation
  ): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.replace(nextConfig, nextDocument, mutation),
      catch: (cause) => routeKitError(cause)
    });
  }
}

export function makeEffectDaemonGenerationManager(
  options: DaemonGenerationManagerOptions
): EffectDaemonGenerationManager {
  return new EffectDaemonGenerationManager(createDaemonGenerationManager(options));
}
