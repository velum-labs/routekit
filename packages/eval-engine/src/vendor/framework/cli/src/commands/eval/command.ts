// RFC 0009 author-eval-support.md (and RFC 0004 eval.md): the `ori eval` command.
// It does not implement a test runner but discovers `*.eval.ts` files and hands
// them to `node --test`, so authoring an eval reads like a normal Node unit test.
// The injected agent's ephemeral daemon is torn down with the command's scope,
// which is what makes evals runnable in CI: one process, one command, no
// separate `ori dev` to babysit.
import type { Crypto, Terminal } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { Effect, Option } from "effect";
import { Command } from "effect/unstable/cli";

import type { CliOutputAlreadyReported } from "../../../../contracts/internal/src/cli/cli-output.ts";
import type { OutputMode } from "../../../../contracts/internal/src/cli/output-mode.ts";
import type {
  CliFailureError,
  CliIoError,
} from "../../../../contracts/internal/src/errors.ts";
import type { RuntimeSecretStore } from "../../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import type { OriCliExit } from "../../cli-exit.ts";
import type { DevCommandRuntimeOptions } from "../dev/session-support.ts";
import type { EvalComparison } from "./baseline.ts";
import type { EvalRuntimeProvider } from "./node-test-run.ts";
import type { ProductionEvalServices } from "./daemon-provider.ts";
import type { EvalBaselineSelector } from "./flags.ts";
import type { EvalTestRow } from "./junit.ts";
import type { EvalResultRow } from "./results.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { currentOutputMode } from "../../../../contracts/internal/src/cli/output-mode.ts";
import { reportCommandFailure } from "../../command-failure.ts";
import { runTestsWithResults } from "./node-test-run.ts";
import { makeDaemonRuntimeProvider } from "./daemon-provider.ts";
import { discoverEvalFiles } from "./discover.ts";
import { evalDocsCommand } from "./docs/command.ts";
import { runEvalDryRun } from "./dry-run.ts";
import { reportEmptyDryRun } from "./dry-run-report.ts";
import {
  allowNoKeyFlag,
  baselineFlag,
  dryRunFlag,
  evalTimeoutFlag,
  featuresFlag,
  hostFlag,
  listFlag,
  noHistoryFlag,
  pathFlag,
  reportFlag,
  targetArgument,
} from "./flags.ts";
import { ensurePortableEvalImports } from "./portable-imports.ts";
import {
  reportDiscovery,
  reportRunOutcome,
} from "./report.ts";
import { writeEvalReportMarkdown } from "./report-markdown.ts";
import { recordAndCompareEvalRun } from "./run-history.ts";
import { evalScratchCommand } from "./scratch-command.ts";
import type { evalSystemSkillCommand } from "../../../../../../eval-skill-command.ts";
import { resolveEvalTarget } from "./target.ts";
import { makeEvalTelemetryProps } from "./telemetry.ts";
import { loadStoredOpenRouterKeyIntoEnvFrom } from "../login/credentials.ts";
import { ensureOpenRouterCredential } from "../login/login.ts";
import { Telemetry as TelemetryService } from "../../telemetry/telemetry.ts";

const EVAL_RUN_RECORD_FILE_ENV = "ORI_EVAL_RUN_RECORD_FILE";

const appendEvalRunRecord = Effect.fn("EvalCommand.appendRunRecord")(
  function* (input: {
    readonly exitCode: number;
    readonly files: readonly string[];
    readonly results: readonly EvalResultRow[];
    readonly tests: readonly EvalTestRow[];
    readonly workingDirectory: string;
  }) {
    const hostProcess = yield* HostProcess;
    const env = yield* hostProcess.env;
    const recordFile = env[EVAL_RUN_RECORD_FILE_ENV]?.trim();
    if (recordFile === undefined || recordFile === "") return;
    yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: async () => {
        const { appendFile, mkdir } = await import("node:fs/promises");
        const path = await import("node:path");
        await mkdir(path.dirname(recordFile), { recursive: true });
        await appendFile(
          recordFile,
          `${JSON.stringify({
            endedAt: new Date().toISOString(),
            exitCode: input.exitCode,
            files: input.files,
            results: input.results,
            tests: input.tests,
            workingDirectory: input.workingDirectory,
          })}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
      },
    }).pipe(Effect.ignore);
  }
);

interface EvalCommandConfig {
  readonly allowNoKey: boolean;
  readonly baseline: EvalBaselineSelector;
  readonly dryRun: boolean;
  readonly features: Option.Option<string>;
  readonly host: string;
  readonly list: boolean;
  readonly noHistory: boolean;
  readonly path: Option.Option<string>;
  readonly report: Option.Option<string>;
  readonly target: Option.Option<string>;
  readonly timeout: number;
}

/**
 * Write the shareable report when `--report` named a path, and say where it went.
 *
 * Called before `reportRunOutcome`, which fails the command on a non-zero exit
 * code: a run whose eval failed is exactly the run somebody needs written evidence
 * for, so the file has to be on disk before that failure short-circuits the rest.
 */
const writeReportWhenRequested = Effect.fn("EvalCommand.writeReport")(
  function* (input: {
    readonly cliIo: CliIo["Service"];
    readonly comparison: Option.Option<EvalComparison>;
    readonly files: readonly string[];
    readonly mode: "human" | "json";
    readonly report: Option.Option<string>;
    readonly results: readonly EvalResultRow[];
    readonly tests: readonly EvalTestRow[];
    readonly workingDirectory: string;
  }) {
    if (Option.isNone(input.report)) {
      return;
    }
    const reportPath = yield* writeEvalReportMarkdown({
      comparison: input.comparison,
      files: input.files,
      reportPath: input.report.value,
      results: input.results,
      tests: input.tests,
      workingDirectory: input.workingDirectory,
    });
    // Human mode only: json mode owes an agent exactly one envelope on stdout, and
    // a second line would break the `JSON.parse` it runs over the whole stream.
    if (input.mode === "human") {
      yield* input.cliIo.writeStdout(`\nWrote eval report to ${reportPath}\n`);
    }
  }
);

/**
 * Everything after the child exits, in the order it has to happen.
 *
 * Recording and comparing come first, so a run that spent real model calls and
 * then failed a later assertion is still recorded and still compared. The report
 * is written next, before `reportRunOutcome` fails the command on a non-zero exit
 * code — a failed run is exactly the one somebody needs written evidence for.
 */
const finishEvalRun = Effect.fn("EvalCommand.finish")(function* (input: {
  readonly cliIo: CliIo["Service"];
  readonly config: EvalCommandConfig;
  readonly exitCode: number;
  readonly files: readonly string[];
  readonly mode: "human" | "json";
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
  readonly startedAt: number;
  readonly workingDirectory: string;
}) {
  const telemetry = yield* TelemetryService;
  yield* appendEvalRunRecord({
    exitCode: input.exitCode,
    files: input.files,
    results: input.results,
    tests: input.tests,
    workingDirectory: input.workingDirectory,
  });
  const baseline = yield* recordAndCompareEvalRun({
    exitCode: input.exitCode,
    files: input.files,
    recordEnabled: !input.config.noHistory,
    results: input.results,
    selector: input.config.baseline,
    tests: input.tests,
    workingDirectory: input.workingDirectory,
  });

  yield* writeReportWhenRequested({
    cliIo: input.cliIo,
    comparison: baseline.comparison,
    files: input.files,
    mode: input.mode,
    report: input.config.report,
    results: input.results,
    tests: input.tests,
    workingDirectory: input.workingDirectory,
  });

  yield* telemetry
    .emit(
      "eval_run",
      makeEvalTelemetryProps({
        durationMs: Math.max(
          0,
          (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) -
            input.startedAt
        ),
        exitCode: input.exitCode,
        results: input.results,
        tests: input.tests,
      })
    )
    .pipe(Effect.ignore);

  return yield* reportRunOutcome({
    baseline,
    cliIo: input.cliIo,
    exitCode: input.exitCode,
    files: input.files,
    mode: input.mode,
    results: input.results,
    tests: input.tests,
  });
});

/**
 * Put a credential in the environment the child `node --test` inherits, resolved
 * through the same gate `ori code` uses in its default mode: a key already in
 * the environment, then the workspace `.ori/credentials.json`, then the global
 * `~/.ori/credentials.json` and `~/.openrouter/credentials.json`.
 *
 * "Already in the environment" includes the key the CLI bootstrap resolves from
 * the launch directory before any command runs, so a launch-directory or global
 * credential wins over the eval target's own when the two differ. That is the
 * `ori code` rule, not an eval-specific one, and `--no-global-auth` on `ori
 * code` is what pins a run to one workspace.
 *
 * In json mode the gate must not offer interactive login: stdout carries one
 * envelope, and login prints its URL and success line there.
 *
 * Neither `--list` nor `--dry-run` gets this far: one stops at discovery and the
 * other loads the files without invoking anything, so requiring a secret from
 * either would be asking for one to do nothing with. `--allow-no-key` still
 * resolves a stored credential when one exists; it only declines to fail
 * without one, and never opens an interactive login.
 *
 * Returns the environment as it stands after the gate, which is what the child
 * inherits: a stored credential only reaches the harness because the gate wrote
 * it into the host environment first.
 */
const resolveEvalCredentialEnv = Effect.fn("EvalCommand.resolveCredential")(
  function* (input: {
    readonly allowNoKey: boolean;
    readonly mode: "human" | "json";
    readonly startDir: string;
  }) {
    yield* input.allowNoKey
      ? loadStoredOpenRouterKeyIntoEnvFrom({ startDir: input.startDir })
      : ensureOpenRouterCredential({
          allowInteractiveLogin: input.mode === "human",
          commandName: "eval",
          mode: "resolvable",
          onNonInteractiveMissing: "fail",
          startDir: input.startDir,
        });
    return yield* (yield* HostProcess).env;
  }
);

/**
 * The two ways `ori eval` finishes having run nothing: `--list`, and a directory
 * with no evals in it.
 *
 * A dry run that found nothing takes its own reporter rather than the shared
 * one, because the shared envelope carries `files` alone and an agent branching
 * on `dryRun` should not have to special-case the empty directory.
 */
const reportWithoutRunning = (input: {
  readonly cliIo: CliIo["Service"];
  readonly config: EvalCommandConfig;
  readonly files: readonly string[];
  readonly mode: "human" | "json";
}): Effect.Effect<
  void,
  CliFailureError | CliIoError | CliOutputAlreadyReported
> =>
  input.config.dryRun && !input.config.list
    ? reportEmptyDryRun({
        cliIo: input.cliIo,
        mode: input.mode,
      })
    : reportDiscovery({
        cliIo: input.cliIo,
        files: input.files,
        mode: input.mode,
        run: !input.config.list,
      });

export const runEvalCommand = Effect.fn("EvalCommand.run")(function* <E, R>(
  config: EvalCommandConfig,
  provider: EvalRuntimeProvider<E, R>
) {
  const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const cliIo = yield* CliIo;
  const mode = yield* currentOutputMode();
  const hostProcess = yield* HostProcess;
  const { searchRoot, workingDirectory } = yield* resolveEvalTarget(config);

  const files = yield* discoverEvalFiles(searchRoot);

  if (config.list || files.length === 0) {
    return yield* reportWithoutRunning({
      cliIo,
      config,
      files,
      mode,
    });
  }

  // Runs for a dry run too, which is the difference between `--dry-run` and
  // `--list`: `--list` returns above, having proved only that a file exists.
  yield* ensurePortableEvalImports(files);

  const execPath = globalThis.process.execPath;

  if (config.dryRun) {
    return yield* runEvalDryRun({
      cliIo,
      cwd: workingDirectory,
      env: yield* hostProcess.env,
      execPath,
      files,
      mode,
      timeout: config.timeout,
    });
  }

  const { exitCode, results, tests } = yield* Effect.scoped(
    runTestsWithResults({
      execPath,
      cwd: workingDirectory,
      env: yield* resolveEvalCredentialEnv({
        allowNoKey: config.allowNoKey,
        mode,
        startDir: workingDirectory,
      }),
      files,
      mode,
      provider,
      timeout: config.timeout,
    })
  );

  return yield* finishEvalRun({
    cliIo,
    config,
    exitCode,
    files,
    mode,
    results,
    startedAt,
    tests,
    workingDirectory,
  });
});

export const makeEvalCommand = (
  options: DevCommandRuntimeOptions,
  skillCommand: typeof evalSystemSkillCommand
): Command.Command<
  "eval",
  EvalCommandConfig,
  Record<string, never>,
  CliOutputAlreadyReported | OriCliExit | Terminal.QuitError,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | OutputMode
  | ProductionEvalServices
  | RuntimeSecretStore
> =>
  Command.make(
    "eval",
    {
      allowNoKey: allowNoKeyFlag,
      baseline: baselineFlag,
      dryRun: dryRunFlag,
      features: featuresFlag,
      host: hostFlag,
      list: listFlag,
      noHistory: noHistoryFlag,
      path: pathFlag,
      report: reportFlag,
      target: targetArgument,
      timeout: evalTimeoutFlag,
    },
    (config) =>
      runEvalCommand(config, makeDaemonRuntimeProvider(options, config)).pipe(
        reportCommandFailure("eval")
      )
  ).pipe(
    Command.withDescription(
      "Run *.eval.ts agent evals through node --test against a real model, or read the version-matched reference with `ori eval docs`. Prints a per-file pass/fail summary and exits non-zero when any eval fails. Resolves auth exactly as ori code does: OPENROUTER_API_KEY, then a stored credential from ori login, workspace-local or global. Unless --dry-run, --list, or --allow-no-key is passed, a run with no credential anywhere fails before any model call"
    ),
    Command.withSubcommands([
      evalDocsCommand,
      skillCommand,
      evalScratchCommand,
    ])
  );

export type { EvalCommandConfig };
