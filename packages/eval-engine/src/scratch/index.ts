import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { EvalAuthorSdk } from "../sdk/index.js";

export interface EvalScratchWorkspace {
  readonly root: string;
  readonly evalFile: string;
  readonly sdkDirectory: string;
}
export interface EvalScratchService {
  readonly create: Effect.Effect<
    EvalScratchWorkspace,
    never,
    EvalAuthorSdk | FileSystem.FileSystem | Path.Path
  >;
}
export class EvalScratch extends Context.Service<EvalScratch, EvalScratchService>()(
  "@velum-labs/routekit-eval-engine/EvalScratch"
) {}
const starter = `import { setupAgent, setupJudge } from "routekit/eval";\nimport test from "node:test";\n\nconst agent = setupAgent();\nconst judge = setupJudge();\n\ntest("replace this RouteKit Eval", async () => {\n  const run = await agent.run("Replace this prompt with the task to evaluate.");\n  run.toComplete();\n  await judge.autoEvals({ run, criteria: "The result satisfies the task." });\n});\n`;
export const EvalScratchLive = Layer.effect(
  EvalScratch,
  Effect.gen(function* () {
    const sdk = yield* EvalAuthorSdk;
    return EvalScratch.of({
      create: Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "routekit-eval-scratch-" });
        const sdkRoot = path.join(root, "sdk");
        const materialized = yield* sdk.materialize(sdkRoot);
        const nodeModules = path.join(root, "node_modules");
        yield* fs.makeDirectory(nodeModules, { recursive: true });
        yield* fs.symlink(materialized.packageDirectory, path.join(nodeModules, "routekit"));
        const evalFile = path.join(root, "starter.eval.ts");
        yield* fs.writeFileString(evalFile, starter);
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          `${JSON.stringify({ name: "routekit-eval-scratch", private: true, type: "module" }, null, 2)}\n`
        );
        return { root, evalFile, sdkDirectory: materialized.packageDirectory };
      }).pipe(Effect.orDie)
    });
  })
);
