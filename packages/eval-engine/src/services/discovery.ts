import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer } from "effect";
import type {
  EvalDiscoveryError,
  EvalDiscovery as EvalDiscoveryResult,
  EvalTargetOptions
} from "../model.js";
import { discoverEvalFiles } from "../routekit-eval/discovery.js";

export interface EvalDiscoveryService {
  readonly discover: (
    options: EvalTargetOptions
  ) => Effect.Effect<EvalDiscoveryResult, EvalDiscoveryError>;
  readonly list: (
    options: EvalTargetOptions
  ) => Effect.Effect<readonly string[], EvalDiscoveryError>;
}
export class EvalDiscovery extends Context.Service<EvalDiscovery, EvalDiscoveryService>()(
  "@velum-labs/routekit-eval-engine/EvalDiscovery"
) {}
const discover = (options: EvalTargetOptions) =>
  discoverEvalFiles(options).pipe(Effect.provide(nodeServicesLayer));
export const EvalDiscoveryLive = Layer.succeed(EvalDiscovery)(
  EvalDiscovery.of({
    discover,
    list: (options) => discover(options).pipe(Effect.map((result) => result.files))
  })
);
