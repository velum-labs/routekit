import { fileURLToPath } from "node:url";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

export interface MaterializedEvalSdk {
  readonly directory: string;
  readonly packageDirectory: string;
}
export interface EvalAuthorSdkService {
  readonly materialize: (
    directory?: string
  ) => Effect.Effect<MaterializedEvalSdk, never, FileSystem.FileSystem | Path.Path>;
}
export class EvalAuthorSdk extends Context.Service<EvalAuthorSdk, EvalAuthorSdkService>()(
  "@velum-labs/routekit-eval-engine/EvalAuthorSdk"
) {}

const packageJson = `${JSON.stringify({ name: "routekit", version: "0.0.0", private: true, type: "module", exports: { "./eval": "./eval.js" } }, null, 2)}\n`;
const sourceUrl = new URL("../../assets/sdk/eval.js", import.meta.url);
const declarationsUrl = new URL("../../assets/sdk/eval.ts", import.meta.url);

export const EvalAuthorSdkLive = Layer.succeed(EvalAuthorSdk)(
  EvalAuthorSdk.of({
    materialize: (requested) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory =
          requested ?? (yield* fs.makeTempDirectory({ prefix: "routekit-eval-sdk-" }));
        const packageDirectory = path.join(directory, "routekit");
        yield* fs.makeDirectory(packageDirectory, { recursive: true });
        const [javascript, declarations] = yield* Effect.all([
          fs.readFileString(fileURLToPath(sourceUrl)),
          fs.readFileString(fileURLToPath(declarationsUrl))
        ]);
        yield* fs.writeFileString(path.join(packageDirectory, "eval.js"), javascript);
        yield* fs.writeFileString(path.join(packageDirectory, "eval.d.ts"), declarations);
        yield* fs.writeFileString(path.join(packageDirectory, "package.json"), packageJson);
        return { directory, packageDirectory };
      }).pipe(Effect.orDie)
  })
);
