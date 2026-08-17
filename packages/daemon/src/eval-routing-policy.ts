import { join } from "node:path";

import {
  makeRoutingSnapshotStore,
  makeRoutingSnapshotStoreV2
} from "@velum-labs/routekit-eval-store/effect";
import {
  type CompositionalRoutingPolicyReader,
  RoutingPolicyReadError,
  type RoutingPolicyReader
} from "@velum-labs/routekit-gateway";
import { Effect } from "effect";

/** Daemon-owned location for the compact policy artifact consumed online. */
export function evalRoutingSnapshotDirectory(routekitHome: string): string {
  return join(routekitHome, "eval");
}

/**
 * Read the current published snapshot for every request.
 *
 * Publishing is atomic, so router generations do not need to restart when an
 * approved eval policy replaces the snapshot.
 */
export function makeEvalRoutingPolicyReader(routekitHome: string): RoutingPolicyReader {
  const snapshots = makeRoutingSnapshotStore(evalRoutingSnapshotDirectory(routekitHome));
  const listProfiles: RoutingPolicyReader["listProfiles"] = () =>
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
      Effect.map((snapshot) => snapshot?.profiles ?? {}),
      Effect.mapError(
        (cause) =>
          new RoutingPolicyReadError({
            profileId: "*",
            message: "failed to read published routing profiles",
            cause
          })
      )
    );
  return {
    listProfiles,
    getProfile: (profileId) => listProfiles().pipe(Effect.map((profiles) => profiles[profileId]))
  };
}

/**
 * Read the independently versioned compositional snapshot without restarting
 * router generations. A corrupt current file falls back to the last known-good
 * publication, matching the v1 online policy behavior.
 */
export function makeCompositionalRoutingPolicyReader(
  routekitHome: string
): CompositionalRoutingPolicyReader {
  const snapshots = makeRoutingSnapshotStoreV2(evalRoutingSnapshotDirectory(routekitHome));
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
