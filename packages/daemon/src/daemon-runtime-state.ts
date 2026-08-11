import { createHash } from "node:crypto";

import type { RouterConfig } from "@velum-labs/routekit-config";
import { ControlError } from "@velum-labs/routekit-runtime";

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
  #mutationTail: Promise<void> = Promise.resolve();

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

  async awaitMutations(): Promise<void> {
    await this.#mutationTail;
  }

  async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#lifecycle !== "running") {
      throw new ControlError({
        code: "unavailable",
        message: "RouteKit daemon is shutting down"
      });
    }
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return await result;
  }

  snapshot(): DaemonRuntimeSnapshot {
    return {
      configRevision: this.#revisions.config,
      accountRevision: this.#revisions.accounts,
      configHash: createHash("sha256").update(this.#document).digest("hex")
    };
  }
}
