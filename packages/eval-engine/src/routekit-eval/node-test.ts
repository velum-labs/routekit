/**
 * Adapted from RouteKit Eval's scoped node:test runner, dry-run strategy, JUnit channel,
 * and crash-tolerant JSONL result channel.
 *
 * RouteKit Eval sources:
 * framework/cli/src/commands/eval/{node-test-run,dry-run,results,junit}.ts
 */
import { Clock, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { EvalResultRow, EvalTestRow } from "../model.js";
import { EvalResultReadError, EvalSpawnError } from "../model.js";
import { parseNodeJunit } from "./junit.js";
import { decodeResultLine, joinOutcomes } from "./results-lines.js";

export const EVAL_RESULTS_FILE_ENV = "ROUTEKIT_EVAL_RESULTS_FILE";
export const DRY_RUN_PATTERN = "__ROUTEKIT_EVAL_DRY_RUN_NEVER__";

const HEALTHY_DRY_RUN = /^ℹ tests (\d+)\r?\nℹ suites \d+\r?\nℹ pass \1\r?\nℹ fail 0\b/mu;

export interface NodeTestOutput {
  readonly exitCode: number;
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const nodeTestArguments = (input: {
  readonly files: readonly string[];
  readonly junitPath: string;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
}): readonly string[] => [
  "--experimental-strip-types",
  "--test",
  `--test-timeout=${String(input.timeoutMs)}`,
  "--test-reporter=junit",
  `--test-reporter-destination=${input.junitPath}`,
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  ...(input.dryRun ? [`--test-name-pattern=${DRY_RUN_PATTERN}`] : []),
  ...input.files
];

const readOptional = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.option);
  });

export const isHealthyDryRun = (input: {
  readonly files: readonly string[];
  readonly exitCode: number;
  readonly output: string;
  readonly tests: readonly EvalTestRow[];
}): boolean => {
  if (input.exitCode !== 0 || input.tests.length !== input.files.length) return false;
  const match = HEALTHY_DRY_RUN.exec(input.output);
  return match !== null && Number(match[1]) === input.files.length;
};

export const executeNodeTests = Effect.fn("EvalEngine.executeNodeTests")(function* (input: {
  readonly nodeExecutable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly files: readonly string[];
  readonly timeoutMs: number;
  readonly dryRun: boolean;
}) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs
        .makeTempDirectoryScoped({
          prefix: "routekit-eval-engine-"
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EvalResultReadError({
                path: "temporary eval directory",
                cause
              })
          )
        );
      const junitPath = path.join(directory, "tests.xml");
      const resultsPath = path.join(directory, "results.jsonl");
      const startedAt = yield* Clock.currentTimeMillis;
      const command = ChildProcess.make(
        input.nodeExecutable,
        [
          ...nodeTestArguments({
            files: input.files,
            junitPath,
            timeoutMs: input.timeoutMs,
            dryRun: input.dryRun
          })
        ],
        {
          cwd: input.cwd,
          env: {
            ...input.environment,
            [EVAL_RESULTS_FILE_ENV]: resultsPath
          },
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe"
        }
      );
      const handle = yield* spawner.spawn(command).pipe(
        Effect.mapError(
          (cause) =>
            new EvalSpawnError({
              executable: input.nodeExecutable,
              cause
            })
        )
      );
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          handle.exitCode,
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString)
        ],
        { concurrency: "unbounded" }
      ).pipe(
        Effect.mapError(
          (cause) =>
            new EvalSpawnError({
              executable: input.nodeExecutable,
              cause
            })
        )
      );
      const [junit, resultLines] = yield* Effect.all([
        readOptional(junitPath),
        readOptional(resultsPath)
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new EvalResultReadError({
              path: directory,
              cause
            })
        )
      );
      const tests = Option.match(junit, {
        onNone: (): readonly EvalTestRow[] => [],
        onSome: parseNodeJunit
      });
      const results = Option.match(resultLines, {
        onNone: (): readonly EvalResultRow[] => [],
        onSome: (contents) =>
          joinOutcomes(
            contents
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .flatMap((line) => {
                const decoded = decodeResultLine(line);
                return decoded === undefined ? [] : [decoded];
              })
          )
      });
      return {
        exitCode: Number(exitCode),
        results,
        tests,
        durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
        stdout,
        stderr
      } satisfies NodeTestOutput;
    })
  );
});
