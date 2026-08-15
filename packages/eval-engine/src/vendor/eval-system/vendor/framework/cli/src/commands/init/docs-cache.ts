import { Effect, FileSystem, Option, Path } from "effect";

import { loadDocsBundle } from "./docs-bundle-source.ts";
import { RouteKitEvalDirectory } from "../../routekit-eval-directory.ts";

const DOCS_LLMS_FILE = "llms.txt";

const writeIfChanged = Effect.fn("ProjectInit.writeDocIfChanged")(function* (
  fs: FileSystem.FileSystem,
  filePath: string,
  expected: string
) {
  const current = yield* fs.readFileString(filePath).pipe(Effect.option);
  if (Option.getOrUndefined(current) !== expected) {
    yield* fs.writeFileString(filePath, expected);
  }
});

/**
 * Materialize the RouteKitEval docs into `<projectRoot>/.routekit-eval/docs/` so the intern can read
 * version-matched docs locally (the built-in `feature-development` skill points
 * them here). The docs come from the `docs-bundle.json` release asset via
 * {@link loadDocsBundle}, which downloads it once per CLI version and caches it
 * under `~/.routekit-eval/cache/docs/`. `.routekit-eval/` is gitignored, and the writes are
 * idempotent, so re-running on `routekit-eval dev` only touches changed files.
 */
export const writeDocsCache = Effect.fn("ProjectInit.writeDocsCache")(
  function* (projectRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
    const bundle = yield* loadDocsBundle;
    const docsRoot = routeKitEvalDirectory.docsCacheDir(projectRoot);

    yield* fs.makeDirectory(docsRoot, { recursive: true });
    yield* writeIfChanged(fs, path.join(docsRoot, DOCS_LLMS_FILE), bundle.llms);

    for (const [relativePath, content] of Object.entries(bundle.files)) {
      const filePath = path.resolve(docsRoot, relativePath);
      // The bundle is downloaded, so a key like `../../.bashrc` must not escape
      // the docs cache. Anything outside it is dropped rather than written.
      if (!filePath.startsWith(docsRoot + path.sep)) {
        continue;
      }
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* writeIfChanged(fs, filePath, content);
    }
  }
);

export { DOCS_LLMS_FILE };
