import { Effect } from "effect";

import type { StateStoreContribution } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { NamedContributionEntry } from "../../../../engine/registries/src/capability-entries.ts";

/**
 * Boot step 8 — state-store composition (RFC 0003 runtime-composition.md / RFC 0005 state-store.md).
 *
 * `bootFeatureProject` builds the `db` registry but does not open any store,
 * because opening a store is asynchronous I/O while boot is pure. This module
 * performs that post-boot step: it selects the default `db` entry and exposes
 * it as the runtime `state` shorthand.
 */

interface StateStoreResolution {
  /**
   * The selected/default opened store, exposed as the runtime `state`
   * shorthand and injected into agent/cmd/route contexts (RFC 0005 runtime-hooks-and-extensions.md).
   * `undefined` when the project contributes no `db` entry.
   */
  readonly defaultStore?: StateStoreContribution | undefined;
  /** The default entry's registry name, when a default store exists. */
  readonly defaultStoreName?: string | undefined;
  /** Contribution-local diagnostics from selection. */
  readonly diagnostics: readonly string[];
}

interface StateStoreResolutionInput {
  readonly dbEntries: readonly NamedContributionEntry<StateStoreContribution>[];
  readonly defaultStoreName?: string | undefined;
}

const resolveDefaultStateStoreEntry = (input: {
  readonly byName: ReadonlyMap<
    string,
    NamedContributionEntry<StateStoreContribution>
  >;
  readonly defaultStoreName?: string | undefined;
  readonly entries: readonly NamedContributionEntry<StateStoreContribution>[];
}): NamedContributionEntry<StateStoreContribution> | undefined => {
  if (input.defaultStoreName !== undefined) {
    return input.byName.get(input.defaultStoreName);
  }

  // Fallback for direct resolver callers that do not provide runtime selection:
  // registration already deduped by name and ordered entries deterministically.
  return input.entries[0];
};

/**
 * Resolve the default `db` store. Pure with respect to the framework.
 */
export const resolveStateStore = (
  input: StateStoreResolutionInput
): Effect.Effect<StateStoreResolution> =>
  Effect.sync(() => {
    const byName = new Map(input.dbEntries.map((entry) => [entry.name, entry]));
    const defaultEntry = resolveDefaultStateStoreEntry({
      byName,
      defaultStoreName: input.defaultStoreName,
      entries: input.dbEntries,
    });

    return {
      defaultStore: defaultEntry?.value,
      defaultStoreName: defaultEntry?.name,
      diagnostics: [],
    } satisfies StateStoreResolution;
  }).pipe(Effect.withSpan("FeatureBoot.resolveStateStore"));

export type { StateStoreResolution };
