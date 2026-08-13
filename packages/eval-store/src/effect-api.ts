import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import type { EvalEvidence, EvalRunResult } from "@velum-labs/routekit-eval-contracts";
import { Effect } from "effect";

import { createEvalStore, type EvalStore } from "./store.js";

export class EffectEvalStore {
  readonly #inner: EvalStore;

  constructor(root: string) {
    this.#inner = createEvalStore(root);
  }

  get inner(): EvalStore {
    return this.#inner;
  }

  writeRawRun(result: EvalRunResult): Effect.Effect<string, Error> {
    return Effect.try({
      try: () => this.#inner.writeRawRun(result),
      catch: (cause) => routeKitError(cause)
    });
  }

  readRawRun(runId: string): Effect.Effect<EvalRunResult | undefined, Error> {
    return Effect.try({
      try: () => this.#inner.readRawRun(runId),
      catch: (cause) => routeKitError(cause)
    });
  }

  publish(result: EvalRunResult): Effect.Effect<EvalEvidence, Error> {
    return Effect.try({
      try: () => this.#inner.publish(result),
      catch: (cause) => routeKitError(cause)
    });
  }

  readPublished(): Effect.Effect<EvalEvidence | undefined, Error> {
    return Effect.try({
      try: () => this.#inner.readPublished(),
      catch: (cause) => routeKitError(cause)
    });
  }
}

export function makeEffectEvalStore(root: string): EffectEvalStore {
  return new EffectEvalStore(root);
}
