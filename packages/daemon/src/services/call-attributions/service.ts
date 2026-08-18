import type { LeaderboardConfig } from "@velum-labs/routekit-config";
import { Context, Effect, Layer } from "effect";

import { CallAttributionStore } from "../../call-attribution-store.js";

export type CallAttributionsValue = Pick<
  CallAttributionStore,
  "budget" | "configureBudget" | "get" | "list" | "onModelCall" | "size" | "truncated"
>;

/** Daemon-lifetime bounded model-call attribution index. */
export class CallAttributions extends Context.Service<
  CallAttributions,
  CallAttributionsValue
>()("@velum-labs/routekit-daemon/CallAttributions") {
  static layer(config: LeaderboardConfig) {
    return Layer.effect(
      CallAttributions,
      Effect.acquireRelease(
        Effect.sync(
          () =>
            new CallAttributionStore({
              limit: config.liveLimit,
              ttlMs: config.liveTtlHours * 60 * 60 * 1_000
            })
        ),
        (store) => Effect.sync(() => store.clear())
      )
    );
  }
}
