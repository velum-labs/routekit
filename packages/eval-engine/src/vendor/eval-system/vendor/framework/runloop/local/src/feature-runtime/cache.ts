import { Effect, Ref } from "effect";

import type { FeatureBootResult } from "../feature-boot/types.ts";

import { makeAuthorStoreResolver } from "../author/store-resolver.ts";
import { runtimeFatalBootDiagnostics } from "../feature-boot/diagnostics.ts";

const shouldClosePreviousRuntimeGraph = (
  previous: FeatureBootResult,
  affectedFeatureIds: readonly string[] | undefined
): boolean => {
  if (affectedFeatureIds === undefined) {
    return true;
  }

  const previousFeatureIds = previous.definition.enabledFeatures.map(
    (feature) => feature.id
  );
  if (previousFeatureIds.length === 0) {
    return true;
  }

  const affected = new Set(affectedFeatureIds);
  return previousFeatureIds.every((featureId) => affected.has(featureId));
};

export const commitFeatureBootResult = Effect.fn(
  "FeatureRuntimeCache.commitFeatureBootResult"
)(function* (input: {
  readonly affectedFeatureIds?: readonly string[] | undefined;
  readonly boot: FeatureBootResult;
  readonly cache: Ref.Ref<Map<string, FeatureBootResult>>;
  readonly resolvedRoot: string;
}) {
  // Cache on "the runtime can serve a turn", not on "the workspace is clean".
  // A workspace carrying one stale contribution boots degraded and stays
  // degraded until the file changes (which arrives as an explicit reload), so
  // gating on `valid` here would re-import every feature module on every turn
  // and never arm the hook registry.
  if (
    runtimeFatalBootDiagnostics(input.boot.structuredDiagnostics).length > 0
  ) {
    return;
  }

  if (input.boot.hookRegistry !== undefined) {
    const effectContext = yield* Effect.context();
    const state = yield* input.boot.dbRegistry.default.pipe(Effect.option);
    input.boot.hookRegistry.arm(
      state._tag === "Some"
        ? makeAuthorStoreResolver(effectContext, input.boot, state.value)
        : undefined
    );
  }

  const entries = yield* Ref.get(input.cache);
  const previous = entries.get(input.resolvedRoot);
  if (
    previous &&
    previous !== input.boot &&
    shouldClosePreviousRuntimeGraph(previous, input.affectedFeatureIds)
  ) {
    yield* previous.runtimeGraph.close();
  }

  yield* Ref.set(
    input.cache,
    new Map([...entries, [input.resolvedRoot, input.boot]])
  );
});
