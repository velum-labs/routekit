import { Effect } from "effect";

import type { FeatureConfig } from "../../../../contracts/author/src/feature-config.ts";
import type { StoreResolver } from "../../../../contracts/author/src/stores.ts";

import { installFeatureState } from "../../../../contracts/author/src/state.ts";
import { makeAuthorStoreResolver } from "../../../../runloop/local/src/author/store-resolver.ts";
import { FeatureRuntime } from "../../../../runloop/local/src/feature-runtime/service.ts";
import { installGlobalFeatureConfig } from "../../config/author-config-resolver.ts";

/**
 * Resolve the in-process default store and install it on the process-global
 * `ori/state` slot for the lifetime of the session scope, so contextless feature
 * code (`import { db } from "ori/state"`, a chat surface's `start()` before any
 * turn) reaches the same store the daemon owns. Returns the resolver so the chat
 * runner can also thread it into `Chat.stores` (the injected handle a
 * contribution prefers when one is in scope). Returns `undefined` when the
 * project contributes no `db` (Feature State Store Access, RFC 0005); the global
 * `db()` then rejects rather than handing back a store that loses writes.
 *
 * Extracted from `contribution-runners.ts` to keep that file within the
 * architecture line budget; it already owns each `start*` runner.
 */
export const installGlobalFeatureState = Effect.fn("DevCommand.featureState")(
  function* (featuresRoot: string) {
    const runtime = yield* FeatureRuntime;
    const boot = yield* runtime.inspect(featuresRoot).pipe(Effect.option);
    if (boot._tag === "None") {
      return;
    }
    const state = yield* boot.value.dbRegistry.default.pipe(Effect.option);
    if (state._tag === "None") {
      return;
    }
    const context = yield* Effect.context();
    const resolver = makeAuthorStoreResolver(context, boot.value, state.value);
    // Scoped install: restore the prior occupant when the session scope closes,
    // mirroring `globalFeatureLogLayer` so a torn-down runtime never leaves a
    // dangling resolver and a restarted one re-installs cleanly.
    const restore = installFeatureState(resolver);
    yield* Effect.addFinalizer(() => Effect.sync(restore));
    return resolver;
  }
);

/**
 * Install both process-global feature resolvers (state and config) for the
 * session scope when feature code runs in-process, so `import { db } from
 * "ori/state"`/`Chat.stores` and `import { config } from "ori/config"`/
 * `Chat.config` both resolve for a chat surface's `start()`. Returns both
 * resolvers (or `undefined` each) so the chat runner can thread them into the
 * injected `Chat` handle.
 */
export const installSessionFeatureResolvers = Effect.fn(
  "DevCommand.sessionResolvers"
)(function* (input: {
  readonly featuresRoot: string;
  readonly runsFeatureCode: boolean;
  readonly workspaceRoot: string;
}) {
  const empty: {
    readonly configResolver: FeatureConfig | undefined;
    readonly storeResolver: StoreResolver | undefined;
  } = {
    configResolver: undefined,
    storeResolver: undefined,
  };
  if (!input.runsFeatureCode) {
    return empty;
  }
  const storeResolver = yield* installGlobalFeatureState(input.featuresRoot);
  const configResolver = yield* installGlobalFeatureConfig(input.workspaceRoot);
  return {
    configResolver,
    storeResolver,
  };
});
