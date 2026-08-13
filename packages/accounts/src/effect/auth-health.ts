import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  AccountAuthCoordinator,
  type AccountAuthCoordinatorOptions,
  type AccountAuthSnapshot,
  type AuthRecoveryClaim,
  type AuthRecoveryOutcome
} from "../auth-health.js";

export type EffectAuthRecovery =
  | { readonly role: "owner"; readonly claim: AuthRecoveryClaim }
  | { readonly role: "waiter"; readonly completion: Effect.Effect<AuthRecoveryOutcome> }
  | { readonly role: "blocked"; readonly snapshot: AccountAuthSnapshot }
  | { readonly role: "superseded"; readonly currentFingerprint: string };

/**
 * Effect façade over the auth-health owner/waiter state machine.
 *
 * Shared recovery still survives caller cancellation: waiters observe the
 * coordinator's existing deferred, and interrupting a waiter does not abort
 * the owner. Selection/backoff policy stays on `AccountAuthCoordinator`.
 */
export class EffectAccountAuthCoordinator {
  readonly #inner: AccountAuthCoordinator;

  constructor(options: AccountAuthCoordinatorOptions = {}) {
    this.#inner = new AccountAuthCoordinator(options);
  }

  get inner(): AccountAuthCoordinator {
    return this.#inner;
  }

  beginRecovery(identity: string, fingerprint: string): Effect.Effect<EffectAuthRecovery, Error> {
    return Effect.try({
      try: () => {
        const started = this.#inner.beginRecovery(identity, fingerprint);
        if (started.role === "waiter") {
          return {
            role: "waiter" as const,
            completion: Effect.promise(() => started.completion)
          };
        }
        return started;
      },
      catch: (cause) => routeKitError(cause)
    });
  }

  completion(identity: string, fingerprint: string): Effect.Effect<AuthRecoveryOutcome, Error> {
    return Effect.try({
      try: () => {
        const pending = this.#inner.completion(identity, fingerprint);
        if (pending === undefined) {
          throw new Error("no in-flight auth recovery");
        }
        return pending;
      },
      catch: (cause) => routeKitError(cause)
    }).pipe(Effect.flatMap((pending) => Effect.promise(() => pending)));
  }

  snapshot(
    identity: string,
    fingerprint: string
  ): Effect.Effect<AccountAuthSnapshot | { kind: "superseded"; currentFingerprint: string }> {
    return Effect.sync(() => this.#inner.snapshot(identity, fingerprint));
  }

  close(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.close();
    });
  }
}

export function makeEffectAccountAuthCoordinator(
  options: AccountAuthCoordinatorOptions = {}
): EffectAccountAuthCoordinator {
  return new EffectAccountAuthCoordinator(options);
}
