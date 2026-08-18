import { Effect, FileSystem } from "effect";

import { TestdriveWorkflowError } from "./contracts.js";

/** Build the bounded source inventory available to dimension-suite authoring. */
export const repositoryInventory = (repositoryRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const readme = (yield* fs.readFileString(`${repositoryRoot}/README.md`)).slice(0, 12_000);
    const packageFiles = yield* fs.glob("packages/*/package.json", { root: repositoryRoot });
    const docFiles = yield* fs.glob("docs/*.md", { root: repositoryRoot });
    return {
      readme,
      files: ["README.md", ...packageFiles, ...docFiles]
        .map((file) => file.replace(`${repositoryRoot}/`, ""))
        .sort(),
      packages: packageFiles
        .map((file) => file.replace(`${repositoryRoot}/`, ""))
        .sort()
        .slice(0, 80),
      docs: docFiles
        .map((file) => file.replace(`${repositoryRoot}/`, ""))
        .sort()
        .slice(0, 80)
    };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TestdriveWorkflowError({
          phase: "repository-inventory",
          detail: "failed to build bounded repository inventory",
          cause
        })
    )
  );
