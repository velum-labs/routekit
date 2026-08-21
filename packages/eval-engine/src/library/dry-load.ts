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
const DRY_LOAD_OUTPUT_LIMIT_BYTES = 16 * 1024;

export interface EvalDryLoadDiscovery {
  readonly workingDirectory: string;
  readonly files: readonly string[];
}

export class EvalEngineDryLoadError extends Data.TaggedError("EvalEngineDryLoadError")<{
  readonly cause: unknown;
  readonly files: readonly string[];
  readonly stderr?: string;
  readonly stdout?: string;
}> {
  override get message(): string {
    const output = [
      this.stdout === undefined || this.stdout.length === 0
        ? undefined
        : `node:test stdout:\n${this.stdout}`,
      this.stderr === undefined || this.stderr.length === 0
        ? undefined
        : `node:test stderr:\n${this.stderr}`
    ].filter((value): value is string => value !== undefined);
    return ["RouteKit Eval files could not be loaded safely through node:test.", ...output].join(
      "\n"
    );
  }
}

const collectBoundedOutput = (
  stream: Stream.Stream<Uint8Array, unknown>
): Effect.Effect<string, unknown> =>
  stream.pipe(
    Stream.runFold(
      () => ({
        bytes: 0,
        chunks: [] as Uint8Array[],
        truncated: false
      }),
      (captured, chunk) => {
        const remaining = DRY_LOAD_OUTPUT_LIMIT_BYTES - captured.bytes;
        if (remaining <= 0) {
          captured.truncated = true;
          return captured;
        }
        const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        captured.chunks.push(retained);
        captured.bytes += retained.byteLength;
        if (retained.byteLength < chunk.byteLength) captured.truncated = true;
        return captured;
      }
    ),
    Effect.map((captured) => {
      const output = new TextDecoder().decode(
        Buffer.concat(captured.chunks.map((chunk) => Buffer.from(chunk)))
      );
      return captured.truncated ? `${output}\n[output truncated]` : output;
    })
  );

/**
 * Load authored eval files exactly as the concrete executor does, while a test
 * name filter prevents every registered test body from running.
 *
 * The child receives no inherited environment, gateway origin, or credential.
 * Top-level module evaluation still runs, so syntax errors, unresolved imports,
 * and initialization failures fail validation without making an inference call.
 */
const runDryLoad = Effect.fn("EvalEngine.dryLoad")(function* (
  discovery: EvalDryLoadDiscovery,
  execPath: string
) {
  if (discovery.files.length === 0) {
    return;
  }
  const junitPath = yield* makeEvalJunitPath();
  const sdk = yield* acquireEvalSdk(discovery.workingDirectory);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(
    execPath,
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
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [handle.exitCode, collectBoundedOutput(handle.stdout), collectBoundedOutput(handle.stderr)],
    { concurrency: "unbounded" }
  );
  if (Number(exitCode) !== 0) {
    const output = [
      stdout.length === 0 ? undefined : `stdout:\n${stdout}`,
      stderr.length === 0 ? undefined : `stderr:\n${stderr}`
    ].filter((value): value is string => value !== undefined);
    return yield* new EvalEngineDryLoadError({
      cause: new Error(
        [`node:test exited with code ${String(Number(exitCode))}`, ...output].join("\n")
      ),
      files: discovery.files,
      ...(stderr.length === 0 ? {} : { stderr }),
      ...(stdout.length === 0 ? {} : { stdout })
    });
  }
}, Effect.scoped);

export const dryLoadEvals = (
  discovery: EvalDryLoadDiscovery,
  execPath: string = globalThis.process.execPath
): Effect.Effect<
  void,
  EvalEngineDryLoadError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  runDryLoad(discovery, execPath).pipe(
    Effect.mapError((cause) =>
      cause instanceof EvalEngineDryLoadError
        ? cause
        : new EvalEngineDryLoadError({
            cause,
            files: discovery.files
          })
    )
  );
