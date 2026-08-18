import type { RouterConfig } from "@velum-labs/routekit-config";
import type {
  CompositionalRoutingPolicyReader,
  ProvenanceSink
} from "@velum-labs/routekit-gateway";
import { Context } from "effect";

import type { DaemonGenerationManager, DaemonGenerationStage } from "../../daemon-generations.js";

export type DaemonGenerationHooks = {
  drainGraceMs: number;
  routerEnv: () => NodeJS.ProcessEnv;
  provenance: ProvenanceSink;
  compositionalPolicyReader?: CompositionalRoutingPolicyReader;
  wantsSidecar(config: RouterConfig): boolean;
  applyConfig(config: RouterConfig): void;
  activeCredentialFingerprints(): Map<string, string>;
  onStage?: (stage: DaemonGenerationStage) => void;
};

/**
 * @effect-expect-leaking ChildProcessSpawner | Crypto | FileSystem | HttpClient | Path | Stdio | Terminal
 */
export class Generations extends Context.Service<Generations, DaemonGenerationManager>()(
  "@velum-labs/routekit-daemon/Generations"
) {}
