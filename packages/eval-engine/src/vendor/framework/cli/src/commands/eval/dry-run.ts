// `ori eval --dry-run`: prove an eval loads without spending a model call.
//
// There is no dry-run seam in the eval SDK to reach for, and adding one would
// put a "do nothing" branch inside the agent that every real run then carries.
// `node --test` already has the semantics: a `--test-name-pattern` matching no
// test name loads every file, runs its top level, and then runs no test body. A
// model is only ever reached from inside a test body, so nothing is spent.
//
// Split out of `command.ts` because that file is at the max-lines cap, and
// because the whole delicate part of this feature — telling a healthy dry run
// apart from a file that failed to load — belongs in one place.
import { basename } from "node:path";

import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import {
  acquireEvalSdk,
  evalNodeTestArgs,
} from "./node-test-run.ts";
import { applyEvalSdkEnv } from "./sdk-injection.ts";
import { reportDryRun } from "./dry-run-report.ts";
import {
  makeEvalJunitPath,
  readEvalTests,
} from "./junit.ts";

/**
 * The `--test-name-pattern` handed to `node --test`. A negative lookahead of
 * the empty string (`(?!)`) still ran test bodies on Node 24.5.0 (`pass 1`,
 * exit 0), so this is a sentinel that cannot appear in a real test name.
 *
 * Proven with a fixture: top-level `console.log` runs, the `test()` body does
 * not, and a file that fails to load exits non-zero.
 */
const NEVER_MATCHES = "__ORI_EVAL_DRY_RUN_NEVER__";

const EXIT_OK = 0;

/**
 * Node's spec reporter, not an API.
 *
 * `--test-name-pattern='__ORI_EVAL_DRY_RUN_NEVER__'` still counts each *file*
 * as one passing test (`✔ <path>`, `tests N`, `pass N`, `fail 0`, exit 0) even
 * though no `test()` body ran. That file-level summary is the healthy
 * fingerprint. A load failure prints `ERR_MODULE_NOT_FOUND`, `fail 1`, and
 * exits 1 — it cannot produce `fail 0`.
 *
 * Fail closed: an unrecognised shape is a problem, not a pass. Node is free to
 * reword the spec reporter; when it does, `--dry-run` starts failing loudly.
 *
 * Measured on Node v24.5.0. `pass 0` / `tests 0` do *not* appear on a healthy
 * dry-run; the file itself is the counted test.
 */
const HEALTHY_DRY_RUN =
  /^ℹ tests (\d+)\r?\nℹ suites \d+\r?\nℹ pass \1\r?\nℹ fail 0\b/mu;

const SPEC_REPORTER_LINE = /^(?:✔|ℹ) .*\n?/gmu;

const EvalDryRunSummarySchema = Schema.Struct({
  fileCount: Schema.Int,
  testCount: Schema.Int,
});

type EvalDryRunSummary = typeof EvalDryRunSummarySchema.Type;

/**
 * What the child's output says the run would have done, or nothing when the
 * output is not a shape this knows how to read.
 *
 * Exported for its own test: the invert-and-watch-it-swap case that guards the
 * healthy/broken discrimination lives directly against this function.
 */
export const decodeDryRunOutput = (input: {
  readonly files: readonly string[];
  readonly exitCode: number;
  readonly output: string;
}): Option.Option<EvalDryRunSummary> => {
  if (input.exitCode !== EXIT_OK) {
    return Option.none();
  }
  const match = HEALTHY_DRY_RUN.exec(input.output);
  if (match === null || Number(match[1]) !== input.files.length) {
    return Option.none();
  }
  // File-level checkmarks distinguish a filtered dry-run from a run that
  // actually executed `test()` bodies (those print `✔ <test name>` instead).
  // Node prints the path it was given when that is what the child cwd makes
  // unique, and the basename when the process cwd already is the file's
  // directory — `--path` is often absolute while tests `cwd` into the scratch
  // dir, so matching only the absolute path fail-closes a healthy run.
  const allFilesPassed = input.files.every((file) =>
    input.output.includes(`✔ ${file} (`) ||
    input.output.includes(`✔ ${basename(file)} (`)
  );
  if (!allFilesPassed) {
    return Option.none();
  }
  return Option.some({
    fileCount: input.files.length,
    testCount: 0,
  });
};

/**
 * The child's output as a person should see it.
 *
 * On a healthy run the spec reporter's `✔ <file>` / `ℹ pass N` lines look like
 * tests passing, so they are dropped: what remains is the eval's own top-level
 * output, which is the evidence that the top level ran at all. A failed run is
 * echoed whole, where Node's message names the file and the specifier.
 */
export const displayableOutput = (input: {
  readonly healthy: boolean;
  readonly output: string;
}): string =>
  input.healthy ? input.output.replaceAll(SPEC_REPORTER_LINE, "") : input.output;

/**
 * `node --test` could not be started. The child is `process.execPath`, so this
 * is a spawn failure rather than a missing runtime to install.
 */
const nodeUnavailable = (execPath: string): CliFailureError =>
  new CliFailureError({
    detail: `\`ori eval --dry-run\` could not run \`${execPath}\`. Evals load through \`node --test\`.`,
    hint: "Confirm Node.js >= 22.22 is on PATH, then re-run `ori eval --dry-run`.",
  });

/** Spawn the filtered child and hand back its exit code and combined output. */
const spawnFilteredNodeTest = Effect.fn("EvalDryRun.spawn")(function* (input: {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly execPath: string;
  readonly files: readonly string[];
  readonly junitPath: string;
  readonly timeout: number;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sdk = yield* acquireEvalSdk(input.cwd);
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(
        input.execPath,
        [
          ...evalNodeTestArgs({
            files: input.files,
            junitPath: input.junitPath,
            specDestination: "stdout",
            testNameFilter: NEVER_MATCHES,
            timeout: input.timeout,
          }),
        ],
        {
          cwd: input.cwd,
          env: applyEvalSdkEnv(input.env, sdk),
          // Both piped, never inherited. The verdict is read out of the child's
          // combined streams, and our own stdout owes json mode exactly one
          // envelope, which the spec reporter would otherwise sit in front of.
          stderr: "pipe",
          stdin: "ignore",
          stdout: "pipe",
        }
      )
    )
    // Scoped to the spawn alone, not the whole function. Materializing the SDK
    // above writes a temp directory and the stream drains below read pipes, and
    // both raise the same error type: catching wider would answer a disk or
    // permissions failure by telling somebody to install a tool they have.
    .pipe(
      Effect.catchTag("PlatformError", () => nodeUnavailable(input.execPath))
    );
  // Drained concurrently with the exit: a child whose pipes nobody reads blocks
  // once a pipe buffer fills, and a syntax error prints enough to fill one.
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ],
    { concurrency: "unbounded" }
  );
  return {
    exitCode: Number(exitCode),
    output: `${stdout}${stderr}`,
  };
});

/**
 * Load every discovered eval through `node --test` and run none of them.
 *
 * No daemon is booted and no credential is read: nothing is invoked, so there is
 * nothing for either to serve. The eval's own top-level code still runs, which
 * is the point — that is what proves the imports resolve and a top-level
 * `await candidateModels(...)` reaches the catalog.
 */
export const runEvalDryRun = Effect.fn("EvalCommand.dryRun")(function* (input: {
  readonly cliIo: CliIo["Service"];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly execPath: string;
  readonly files: readonly string[];
  readonly mode: "human" | "json";
  readonly timeout: number;
}) {
  const junitPath = yield* makeEvalJunitPath();
  const { exitCode, output } = yield* spawnFilteredNodeTest({
    cwd: input.cwd,
    env: input.env,
    execPath: input.execPath,
    files: input.files,
    junitPath,
    timeout: input.timeout,
  });
  // Decoded before anything is echoed, because whether the run was healthy
  // decides what the user should see: the spec reporter's file-level passes
  // would otherwise print above a success summary and look like tests ran.
  const summary = decodeDryRunOutput({
    exitCode,
    files: input.files,
    output,
  });
  const display = displayableOutput({
    healthy: Option.isSome(summary),
    output,
  });
  if (display.trim().length > 0) {
    yield* input.cliIo.writeStderr(
      display.endsWith("\n") ? display : `${display}\n`
    );
  }
  // Names come from the JUnit file. On a dry-run Node writes one file-level
  // `<testcase>` per loaded file rather than the filtered-out `test()` names.
  // The healthy fingerprint above is still the verdict: on a run where one file
  // loaded and another did not, Node writes a JUnit file for the half that
  // loaded, so trusting it alone would report a broken eval as a healthy one.
  // Names come from the JUnit file. On a dry-run Node writes one file-level
  // `<testcase>` per loaded file rather than the filtered-out `test()` names,
  // and reports those as passing. No `test()` body ran, so the product status
  // is skipped — the same meaning bun's match-nothing filter used to report.
  const tests = Option.isSome(summary)
    ? (yield* readEvalTests(junitPath)).map((row) => ({
        ...row,
        status: "skipped" as const,
      }))
    : [];
  return yield* reportDryRun({
    cliIo: input.cliIo,
    files: input.files,
    mode: input.mode,
    output,
    summary,
    tests,
  });
}, Effect.scoped);

export { EvalDryRunSummarySchema, HEALTHY_DRY_RUN, NEVER_MATCHES };
export type { EvalDryRunSummary };
