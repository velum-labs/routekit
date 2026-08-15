import { join } from "node:path";

import { makeRoutingSnapshotStore } from "@velum-labs/routekit-eval-store/effect";
import type { RoutingPolicyReader } from "@velum-labs/routekit-gateway";
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
  return {
    getProfile: (profileId) =>
      snapshots.read().pipe(Effect.map((snapshot) => snapshot?.profiles[profileId]))
  };
}
