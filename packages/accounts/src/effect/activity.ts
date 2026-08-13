import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  AccountActivityCoordinator,
  type AccountActivityCoordinatorOptions,
  type AccountActivitySnapshot
} from "../activity.js";

/**
 * Effect façade over the daemon-owned activity coordinator.
 *
 * Durable last-selection metadata, debounce, and inFlight-is-process-local
 * semantics stay on `AccountActivityCoordinator`. Attempt leases release
 * exactly once when the surrounding scope closes.
 */
export class EffectAccountActivityCoordinator {
  readonly #inner: AccountActivityCoordinator;

  constructor(options: AccountActivityCoordinatorOptions = {}) {
    this.#inner = new AccountActivityCoordinator(options);
  }

  get inner(): AccountActivityCoordinator {
    return this.#inner;
  }

  beginAttempt(identity: string): Effect.Effect<() => void, Error> {
    return Effect.try({
      try: () => this.#inner.beginAttempt(identity),
      catch: (cause) => routeKitError(cause)
    });
  }

  attempt(identity: string) {
    return Effect.acquireRelease(this.beginAttempt(identity), (release) => Effect.sync(release));
  }

  snapshot(identity: string): Effect.Effect<AccountActivitySnapshot> {
    return Effect.sync(() => this.#inner.snapshot(identity));
  }

  rename(sourceIdentity: string, targetIdentity: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.rename(sourceIdentity, targetIdentity);
    });
  }

  remove(identity: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.remove(identity);
    });
  }

  reload(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.reload();
    });
  }

  flush(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.flush();
    });
  }

  close(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.close();
    });
  }
}

export function makeEffectAccountActivityCoordinator(
  options: AccountActivityCoordinatorOptions = {}
): EffectAccountActivityCoordinator {
  return new EffectAccountActivityCoordinator(options);
}
