import { createHash } from "node:crypto";

import type { RouterConfig } from "@velum-labs/routekit-config";
import { ControlError } from "@velum-labs/routekit-runtime";
import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Deferred, Effect } from "effect";

import type { RevisionState } from "./daemon-state.js";

export type DaemonLifecycle = "running" | "paused" | "quiescing" | "draining" | "closed";

export type DaemonRuntimeSnapshot = {
  configRevision: number;
  accountRevision: number;
  configHash: string;
};

export class DaemonRuntimeState {
  #config: RouterConfig;
  #document: string;
  #revisions: RevisionState;
  #lifecycle: DaemonLifecycle;
  #draining = false;
  #closed = false;
  #mutationTail: Effect.Effect<void> = Effect.void;

  constructor(input: {
    config: RouterConfig;
    document: string;
    revisions: RevisionState;
    initiallyPaused?: boolean;
  }) {
    this.#config = input.config;
    this.#document = input.document;
    this.#revisions = input.revisions;
    this.#lifecycle = input.initiallyPaused === true ? "paused" : "running";
  }

  get config(): RouterConfig {
    return this.#config;
  }

  set config(config: RouterConfig) {
    this.#config = config;
  }

  get document(): string {
    return this.#document;
  }

  set document(document: string) {
    this.#document = document;
  }

  get revisions(): RevisionState {
    return this.#revisions;
  }

  set revisions(revisions: RevisionState) {
    this.#revisions = revisions;
  }

  get lifecycle(): DaemonLifecycle {
    return this.#lifecycle;
  }

  get draining(): boolean {
    return this.#draining;
  }

  get closed(): boolean {
    return this.#closed;
  }

  beginShutdown(): void {
    this.#closed = true;
    if (this.#lifecycle === "running") this.#lifecycle = "quiescing";
    this.#draining = true;
  }

  beginRetire(): boolean {
    if (
      this.#lifecycle === "quiescing" ||
      this.#lifecycle === "closed" ||
      this.#lifecycle === "draining"
    ) {
      return false;
    }
    this.#lifecycle = "quiescing";
    this.#draining = true;
    return true;
  }

  markDraining(): void {
    this.#lifecycle = "draining";
  }

  markClosed(): void {
    this.#lifecycle = "closed";
  }

  pause(): void {
    if (this.#lifecycle !== "running") {
      throw new ControlError({ code: "unavailable", message: "RouteKit daemon is not mutable" });
    }
    this.#lifecycle = "paused";
  }

  resume(): void {
    if (this.#lifecycle === "paused") this.#lifecycle = "running";
  }

  awaitMutations(): Effect.Effect<void> {
    const self = this;
    return Effect.suspend(() => self.#mutationTail);
  }

  serializeEffect<T, E = never, R = never>(
    operation: Effect.Effect<T, E, R>
  ): Effect.Effect<T, E | Error, R> {
    const self = this;
    return Effect.suspend((): Effect.Effect<T, E | Error, R> => {
      if (self.#lifecycle !== "running") {
        return Effect.fail(
          new ControlError({
            code: "unavailable",
            message: "RouteKit daemon is shutting down"
          })
        );
      }
      const previous = self.#mutationTail;
      const done = Deferred.makeUnsafe<void, never>();
      self.#mutationTail = Deferred.await(done);
      return previous.pipe(
        Effect.flatMap(() => operation),
        Effect.ensuring(Deferred.succeed(done, undefined))
      );
    });
  }

  serializeMutation<T>(operation: () => Promise<T>): Effect.Effect<T, Error> {
    return this.serializeEffect(
      Effect.tryPromise({
        try: operation,
        catch: toRouteKitFailure
      })
    );
  }

  snapshot(): DaemonRuntimeSnapshot {
    return {
      configRevision: this.#revisions.config,
      accountRevision: this.#revisions.accounts,
      configHash: createHash("sha256").update(this.#document).digest("hex")
    };
  }
}
