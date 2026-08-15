// Running the evals: spawning `node --test`, and reading back what the child wrote.
// Split out of `command.ts` so that file stays about the command's shape (flags,
// the daemon provider, reporting) rather than also owning the child process
// contract and the two result files.
import type { PlatformError } from "effect";

import { Effect, FileSystem, Stream } from "effect";
import { Stdio } from "effect/Stdio";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  makeEvalJunitPath,
  readEvalTests,
} from "./junit.ts";
import {
  makeEvalResultsPath,
  ORI_EVAL_RESULTS_FILE_ENV,
  readEvalResults,
} from "./results.ts";
import {
  applyEvalSdkEnv,
  materializeEvalSdk,
} from "./sdk-injection.ts";

type RunNodeTest = (
  env: Record<string, string | undefined>
) => Effect.Effect<
  number,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Stdio
>;

// Generic over its own error `E` and requirements `R` so the production provider
// can carry the full daemon-boot union (see `ProductionEvalErrors` /
// `ProductionEvalServices`) while the no-op test provider carries neither — the
// provider's `E`/`R` flow straight through to `runEvalCommand`'s signature.
interface EvalRuntimeProvider<E = never, R = never> {
  readonly withRuntime: (
    baseEnv: Record<string, string | undefined>,
    runTests: RunNodeTest,
    workingDirectory: string
  ) => Effect.Effect<
    number,
    E,
    R | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Stdio
  >;
}

/**
 * Materialize the bundled eval SDK for `cwd` and remove it when the caller's
 * scope closes. Shared with the dry run, which needs the same `ori/eval`
 * resolution: an eval whose SDK import could not be resolved is exactly the
 * failure a dry run exists to catch.
 */
export const acquireEvalSdk = Effect.fn("EvalCommand.acquireEvalSdk")(
  function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.acquireRelease(
      materializeEvalSdk(cwd),
      (materialized) => {
        if (materialized === undefined || materialized.kind === "borrowed") {
          return Effect.void;
        }
        const linkPath = materialized.linkPath;
        const removeLink =
          linkPath === undefined
            ? Effect.void
            : fs.remove(linkPath).pipe(Effect.ignore);
        return removeLink.pipe(
          Effect.andThen(
            fs.remove(materialized.directory, { recursive: true }).pipe(Effect.ignore)
          )
        );
      }
    );
  }
);

/**
 * The argv for one `node --test` child.
 *
 * Shared with the dry run rather than written twice, because the dry run's whole
 * claim is that it loads the files the same way the real run does. A flag added
 * here that the dry run did not also get would make it validate a load path
 * nobody actually runs.
 *
 * Each reporter has a destination: junit always writes a file, spec goes to
 * stdout in human mode and stderr in json mode so the JSON envelope stays alone
 * on stdout.
 *
 * `testNameFilter` is the dry run's lever: a pattern that matches no test name
 * makes Node load every file and run its top level, then run no test body.
 */
export const evalNodeTestArgs = (input: {
  readonly files: readonly string[];
  readonly junitPath: string;
  readonly specDestination: "stderr" | "stdout";
  readonly testNameFilter: string | undefined;
  readonly timeout: number;
}): readonly string[] => [
  "--experimental-strip-types",
  "--test",
  `--test-timeout=${String(input.timeout)}`,
  "--test-reporter=junit",
  `--test-reporter-destination=${input.junitPath}`,
  "--test-reporter=spec",
  `--test-reporter-destination=${input.specDestination}`,
  ...(input.testNameFilter === undefined
    ? []
    : [`--test-name-pattern=${input.testNameFilter}`]),
  ...input.files,
];

/**
 * Spawn `node --test`.
 *
 * In json mode the child's stdout is piped and forwarded to *our stderr* instead
 * of inherited. Spec is already sent to stderr in that mode; piping stdout is
 * the safety net so a stray line cannot sit in front of the JSON envelope an
 * agent `JSON.parse`s. Sending rather than dropping keeps unexpected output
 * readable when a run fails.
 */
export const runNodeTest = Effect.fn("EvalCommand.runNodeTest")(
  function* (input: {
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly execPath: string;
    readonly files: readonly string[];
    readonly junitPath: string;
    readonly mode: "human" | "json";
    readonly timeout: number;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sdk = yield* acquireEvalSdk(input.cwd);
    const isJson = input.mode === "json";
    const command = ChildProcess.make(
      input.execPath,
      [
        ...evalNodeTestArgs({
          files: input.files,
          junitPath: input.junitPath,
          specDestination: isJson ? "stderr" : "stdout",
          testNameFilter: undefined,
          timeout: input.timeout,
        }),
      ],
      {
        cwd: input.cwd,
        env: applyEvalSdkEnv(input.env, sdk),
        stderr: "inherit",
        stdin: "inherit",
        stdout: isJson ? "pipe" : "inherit",
      }
    );
    const run = Effect.gen(function* () {
      if (!isJson) {
        return Number(yield* spawner.exitCode(command));
      }
      const stdio = yield* Stdio;
      const handle = yield* spawner.spawn(command);
      yield* Stream.run(handle.stdout, stdio.stderr());
      return Number(yield* handle.exitCode);
    });
    return yield* run;
  },
  Effect.scoped
);

/**
 * Run the child with a results file wired up, and read the rows back.
 *
 * One scope owns the results file for the whole child run *and* the read-back:
 * the temp dir is removed when it closes, so reading has to happen inside it.
 * Rows are read on every exit code, not just zero — a run that wrote a row and
 * then failed a later assertion is exactly the case a reviewer needs the row for.
 */
export const runTestsWithResults = Effect.fn("EvalCommand.runWithResults")(
  function* <E, R>(input: {
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly execPath: string;
    readonly files: readonly string[];
    readonly mode: "human" | "json";
    readonly provider: EvalRuntimeProvider<E, R>;
    readonly timeout: number;
  }) {
    const resultsPath = yield* makeEvalResultsPath();
    const junitPath = yield* makeEvalJunitPath();
    const exitCode = yield* input.provider.withRuntime(
      {
        ...input.env,
        [ORI_EVAL_RESULTS_FILE_ENV]: resultsPath,
      },
      (runtimeEnv) =>
        runNodeTest({
          cwd: input.cwd,
          env: runtimeEnv,
          execPath: input.execPath,
          files: input.files,
          junitPath,
          mode: input.mode,
          timeout: input.timeout,
        }),
      input.cwd
    );
    // Both files are read on every exit code, not just zero: a failing run is
    // exactly when the per-test outcomes matter most.
    return {
      exitCode,
      results: yield* readEvalResults(resultsPath),
      tests: yield* readEvalTests(junitPath),
    };
  }
);

export type { EvalRuntimeProvider, RunNodeTest };
