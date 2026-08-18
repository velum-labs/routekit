import type { FileSystem, Path } from "effect";
import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeEvalJunitPath } from "../vendor/framework/cli/src/commands/eval/junit.ts";
import {
  acquireEvalSdk,
  evalNodeTestArgs
} from "../vendor/framework/cli/src/commands/eval/node-test-run.ts";
import { applyEvalSdkEnv } from "../vendor/framework/cli/src/commands/eval/sdk-injection.ts";

const DRY_LOAD_TEST_FILTER = "__ROUTEKIT_EVAL_DRY_LOAD_NEVER__";
const DRY_LOAD_TIMEOUT_MS = 30_000;

export interface EvalDryLoadDiscovery {
  readonly workingDirectory: string;
  readonly files: readonly string[];
}

export class EvalEngineDryLoadError extends Data.TaggedError("EvalEngineDryLoadError")<{
  readonly cause: unknown;
  readonly files: readonly string[];
}> {
  override get message(): string {
    return "RouteKit Eval files could not be loaded safely through node:test.";
  }
}

/**
 * Load authored eval files exactly as the concrete executor does, while a test
 * name filter prevents every registered test body from running.
 *
 * The child receives no inherited environment, gateway origin, or credential.
 * Top-level module evaluation still runs, so syntax errors, unresolved imports,
 * and initialization failures fail validation without making an inference call.
 */
const runDryLoad = Effect.fn("EvalEngine.dryLoad")(function* (discovery: EvalDryLoadDiscovery) {
  if (discovery.files.length === 0) {
    return;
  }
  const junitPath = yield* makeEvalJunitPath();
  const sdk = yield* acquireEvalSdk(discovery.workingDirectory);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(
    globalThis.process.execPath,
    [
      ...evalNodeTestArgs({
        files: discovery.files,
        junitPath,
        specDestination: "stdout",
        testNameFilter: DRY_LOAD_TEST_FILTER,
        timeout: DRY_LOAD_TIMEOUT_MS
      })
    ],
    {
      cwd: discovery.workingDirectory,
      env: applyEvalSdkEnv({}, sdk),
      extendEnv: false,
      forceKillAfter: 5_000,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe"
    }
  );
  const handle = yield* spawner.spawn(command);
  const [exitCode] = yield* Effect.all(
    [handle.exitCode, Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr)],
    { concurrency: "unbounded" }
  );
  if (Number(exitCode) !== 0) {
    return yield* new EvalEngineDryLoadError({
      cause: new Error(`node:test exited with code ${String(Number(exitCode))}`),
      files: discovery.files
    });
  }
}, Effect.scoped);

export const dryLoadEvals = (
  discovery: EvalDryLoadDiscovery
): Effect.Effect<
  void,
  EvalEngineDryLoadError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  runDryLoad(discovery).pipe(
    Effect.mapError((cause) =>
      cause instanceof EvalEngineDryLoadError
        ? cause
        : new EvalEngineDryLoadError({
            cause,
            files: discovery.files
          })
    )
  );
