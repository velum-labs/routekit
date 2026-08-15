import { Effect, Exit, FileSystem, Path } from "effect";
import { Command } from "effect/unstable/cli";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { renderEnvelope } from "../../../../contracts/internal/src/cli/cli-output.ts";
import { currentOutputMode } from "../../../../contracts/internal/src/cli/output-mode.ts";
import { reportCommandFailure } from "../../command-failure.ts";
import { materializeEvalSdk } from "./sdk-injection.ts";

const STARTER_EVAL = `import { setupAgent } from "ori/eval";
import { test } from "node:test";
import assert from "node:assert/strict";

const agent = setupAgent();

test("replace this starter eval", async () => {
  const run = await agent.run("Replace this prompt with the task to evaluate.");
  run.toComplete();
});
`;

const SCRATCH_LOCKFILE = `{
  "name": "ori-eval-scratch",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "ori-eval-scratch",
      "dependencies": {
        "ori": "file:sdk/ori"
      }
    },
    "node_modules/ori": {
      "resolved": "sdk/ori",
      "link": true
    },
    "sdk/ori": {
      "name": "ori",
      "version": "0.0.0",
      "private": true
    }
  }
}
`;

const createScratchWorkspace = Effect.fn("EvalScratch.create")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "ori-eval-scratch-" });
  return yield* Effect.gen(function* () {
    const nodeModules = path.join(root, "node_modules");
    const sdkDirectory = path.join(root, "sdk");
    yield* fs.makeDirectory(path.join(root, "data"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, "features"), { recursive: true });
    yield* fs.makeDirectory(nodeModules, { recursive: true });
    yield* fs.makeDirectory(sdkDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "package.json"),
      `{
  "name": "ori-eval-scratch",
  "private": true,
  "type": "module",
  "dependencies": {
    "ori": "file:sdk/ori"
  }
}
`
    );
    yield* fs.writeFileString(
      path.join(root, "starter.eval.ts.template"),
      STARTER_EVAL
    );
    yield* materializeEvalSdk(root, { directory: sdkDirectory });
    yield* fs.symlink(
      path.join(sdkDirectory, "ori"),
      path.join(nodeModules, "ori")
    );
    // Written so a later `ori eval` in this workspace can reuse the local SDK
    // without resolving through the parent monorepo.
    yield* fs.writeFileString(path.join(root, "package-lock.json"), SCRATCH_LOCKFILE);
    return root;
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : fs.remove(root, { recursive: true }).pipe(Effect.ignore)
    )
  );
});

const SCRATCH_PATH_FILE_ENV = "ORI_EVAL_SCRATCH_PATH_FILE";

const recordScratchPath = Effect.fn("EvalScratch.recordPath")(function* (
  root: string
) {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  const recordFile = env[SCRATCH_PATH_FILE_ENV]?.trim();
  if (recordFile === undefined || recordFile === "") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(recordFile), { recursive: true });
  yield* fs.writeFileString(recordFile, `${root}\n`);
});

export const evalScratchCommand = Command.make("scratch", {}, () =>
  Effect.gen(function* () {
    const cliIo = yield* CliIo;
    const root = yield* createScratchWorkspace();
    yield* recordScratchPath(root);
    if ((yield* currentOutputMode()) === "json") {
      yield* cliIo.writeStdout(renderEnvelope("eval scratch", { path: root }));
      return;
    }
    yield* cliIo.writeStdout(`${root}\n`);
  }).pipe(reportCommandFailure("eval scratch"))
).pipe(
  Command.withDescription(
    "Create a self-contained temporary workspace for a generic model eval"
  )
);
