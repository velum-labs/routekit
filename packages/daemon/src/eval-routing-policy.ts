import { join } from "node:path";

import { makeRoutingActivationStore } from "@velum-labs/routekit-eval-store/effect";
import {
  type CompositionalRoutingPolicyReader,
  RoutingPolicyReadError
} from "@velum-labs/routekit-gateway";
import { Effect } from "effect";

/** Daemon-owned location for the compact policy artifact consumed online. */
export function evalRoutingSnapshotDirectory(routekitHome: string): string {
  return join(routekitHome, "eval");
}

/**
 * Read the compositional snapshot without restarting router generations. A
 * corrupt current file falls back to the last known-good publication.
 */
export function makeCompositionalRoutingPolicyReader(
  routekitHome: string
): CompositionalRoutingPolicyReader {
  const snapshots = makeRoutingActivationStore(evalRoutingSnapshotDirectory(routekitHome));
  return {
    getSnapshot: () =>
      snapshots.read().pipe(
        Effect.catch((currentCause) =>
          snapshots
            .readPrevious()
            .pipe(
              Effect.flatMap((previous) =>
                previous === undefined ? Effect.fail(currentCause) : Effect.succeed(previous)
              )
            )
        ),
        Effect.mapError(
          (cause) =>
            new RoutingPolicyReadError({
              profileId: "*",
              message: "failed to read the compositional routing snapshot",
              cause
            })
        )
      )
  };
}
