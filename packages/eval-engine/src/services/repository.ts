import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

export interface EvalRepositoryPaths {
  readonly root: string;
  readonly history: string;
  readonly state: string;
  readonly cache: string;
}
export interface EvalRepositoryService {
  readonly paths: (workspaceRoot: string) => Effect.Effect<EvalRepositoryPaths>;
  readonly ensure: (workspaceRoot: string) => Effect.Effect<EvalRepositoryPaths>;
}
export class EvalRepository extends Context.Service<EvalRepository, EvalRepositoryService>()(
  "@velum-labs/routekit-eval-engine/EvalRepository"
) {}
const paths = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = path.join(workspaceRoot, ".routekit", "eval");
    return {
      root,
      history: path.join(root, "history.jsonl"),
      state: path.join(root, "authoring"),
      cache: path.join(root, "cache")
    };
  }).pipe(Effect.provide(nodeServicesLayer));
export const EvalRepositoryLive = Layer.succeed(EvalRepository)(
  EvalRepository.of({
    paths,
    ensure: (workspaceRoot) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const result = yield* paths(workspaceRoot);
        yield* fs.makeDirectory(result.root, { recursive: true, mode: 0o700 });
        return result;
      }).pipe(Effect.provide(nodeServicesLayer), Effect.orDie)
  })
);
