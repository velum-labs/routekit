import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Cause, Effect, Fiber, Queue, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  makeEvalJunitPath,
  readEvalTests
} from "../vendor/framework/cli/src/commands/eval/junit.ts";
import {
  acquireEvalSdk,
  evalNodeTestArgs
} from "../vendor/framework/cli/src/commands/eval/node-test-run.ts";
import {
  makeEvalResultsPath,
  ROUTEKIT_EVAL_RESULTS_FILE_ENV,
  readEvalResults
} from "../vendor/framework/cli/src/commands/eval/results.ts";
import {
  applyEvalSdkEnv,
  ROUTEKIT_EVAL_COMPARISON_ID_ENV,
  ROUTEKIT_EVAL_RUNTIME_ORIGIN_ENV
} from "../vendor/framework/cli/src/commands/eval/sdk-injection.ts";
import {
  type EvalEngineDiscovery,
  EvalEngineExecutionError,
  type EvalExecutionOutput,
  type EvalExecutionPortService
} from "./eval-engine.ts";

const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const SENSITIVE_ENVIRONMENT_KEY =
  /(?:^|[_-])(?:api[_-]?key|authorization|bearer|credentials?|password|private[_-]?key|secret|access[_-]?token|auth[_-]?token|bearer[_-]?token|token)(?:$|[_-])/iu;

export interface NodeTestExecutionOptions {
  /**
   * Origin of the scoped parent-side RouteKit Eval runtime bridge.
   *
   * Gateway credentials belong to that bridge and must never be included here.
   */
  readonly bridgeOrigin: string;
  /**
   * Explicit environment made available to eval authors.
   *
   * The adapter does not inherit `process.env`. Credential-shaped keys are
   * rejected because inference authentication remains in the parent process.
   */
  readonly childEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Absolute Node executable path. Defaults to the current Node executable. */
  readonly execPath?: string;
}

const executionError = (detail: string, cause: unknown): EvalEngineExecutionError =>
  cause instanceof EvalEngineExecutionError
    ? cause
    : new EvalEngineExecutionError({ cause, detail });

const validateBridgeOrigin = (raw: string): Effect.Effect<string, EvalEngineExecutionError> =>
  Effect.try({
    try: () => {
      const url = new URL(raw);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        throw new Error("expected an HTTP(S) origin without credentials");
      }
      return url.origin;
    },
    catch: () =>
      executionError(
        "RouteKit Eval runtime bridge origin must be a credential-free HTTP(S) origin.",
        new Error("invalid or credential-bearing bridge origin")
      )
  });

const validateChildEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<Record<string, string | undefined>, EvalEngineExecutionError> =>
  Effect.gen(function* () {
    for (const key of Object.keys(environment)) {
      if (SENSITIVE_ENVIRONMENT_KEY.test(key)) {
        return yield* executionError(
          `RouteKit Eval child environment must not contain credential key ${JSON.stringify(key)}.`,
          new Error("credential-shaped child environment key")
        );
      }
    }
    return { ...environment };
  });

const testFilesWithConcurrency = (
  files: readonly string[],
  concurrency: number | undefined
): readonly string[] =>
  concurrency === undefined ? files : [`--test-concurrency=${String(concurrency)}`, ...files];

const executeNodeTests = (input: {
  readonly bridgeOrigin: string;
  readonly childEnvironment: Readonly<Record<string, string | undefined>>;
  readonly comparisonId: string;
  readonly concurrency: number | undefined;
  readonly discovery: EvalEngineDiscovery;
  readonly execPath: string;
  readonly timeoutMs: number;
}) =>
  Stream.callback<EvalExecutionOutput, EvalEngineExecutionError, any>((queue) =>
    Effect.gen(function* () {
      const resultsPath = yield* makeEvalResultsPath();
      const junitPath = yield* makeEvalJunitPath();
      const sdk = yield* acquireEvalSdk(input.discovery.workingDirectory);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        input.execPath,
        [
          ...evalNodeTestArgs({
            files: testFilesWithConcurrency(input.discovery.files, input.concurrency),
            junitPath,
            specDestination: "stdout",
            testNameFilter: undefined,
            timeout: input.timeoutMs
          })
        ],
        {
          cwd: input.discovery.workingDirectory,
          env: applyEvalSdkEnv(
            {
              ...input.childEnvironment,
              [ROUTEKIT_EVAL_COMPARISON_ID_ENV]: input.comparisonId,
              [ROUTEKIT_EVAL_RESULTS_FILE_ENV]: resultsPath,
              [ROUTEKIT_EVAL_RUNTIME_ORIGIN_ENV]: input.bridgeOrigin
            },
            sdk
          ),
          extendEnv: false,
          forceKillAfter: 5_000,
          stderr: "pipe",
          stdin: "ignore",
          stdout: "pipe"
        }
      );
      const handle = yield* spawner.spawn(command);
      const stdout = yield* Stream.runDrain(handle.stdout).pipe(
        Effect.ignore,
        Effect.forkScoped({ startImmediately: true })
      );
      const stderr = yield* Stream.runDrain(handle.stderr).pipe(
        Effect.ignore,
        Effect.forkScoped({ startImmediately: true })
      );
      let observed = "";
      const publishSnapshot = Effect.gen(function* () {
        const results = yield* readEvalResults(resultsPath);
        const fingerprint = JSON.stringify(results);
        if (fingerprint !== observed) {
          observed = fingerprint;
          Queue.offerUnsafe(queue, { results, tests: [] });
        }
      });
      const watcher = yield* publishSnapshot.pipe(
        Effect.ignore,
        Effect.andThen(Effect.sleep("25 millis")),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true })
      );
      const exitCode = Number(yield* handle.exitCode);
      yield* Fiber.interrupt(watcher);
      yield* Fiber.join(stdout);
      yield* Fiber.join(stderr);

      const results = yield* readEvalResults(resultsPath);
      const tests = yield* readEvalTests(junitPath);
      if (exitCode !== 0 && results.length === 0 && tests.length === 0) {
        return yield* executionError(
          `RouteKit Eval node:test child exited with code ${String(exitCode)} before producing evidence.`,
          new Error(`node:test exit code ${String(exitCode)}`)
        );
      }
      Queue.offerUnsafe(queue, { results, tests });
      Queue.endUnsafe(queue);
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(executionError("RouteKit Eval could not execute node:test.", cause))
          );
        })
      ),
      Effect.forkScoped({ startImmediately: true })
    )
  ).pipe(Stream.scoped, Stream.provide(NodeServicesLayer)) as Stream.Stream<
    EvalExecutionOutput,
    EvalEngineExecutionError,
    never
  >;

/**
 * Construct the concrete `node:test` execution port used by RouteKit Eval.
 *
 * Each execution owns its SDK materialization, result files, JUnit file,
 * output drains, and child process in one Effect scope. Closing or interrupting
 * that scope releases the temporary files and terminates the child process.
 */
export const makeNodeTestExecutionPort = (
  options: NodeTestExecutionOptions
): EvalExecutionPortService => ({
  execute: ({ comparisonId, discovery, request }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const bridgeOrigin = yield* validateBridgeOrigin(options.bridgeOrigin);
        const childEnvironment = yield* validateChildEnvironment(options.childEnvironment ?? {});
        return executeNodeTests({
          bridgeOrigin,
          childEnvironment,
          comparisonId,
          concurrency: request.concurrency,
          discovery,
          execPath: options.execPath ?? globalThis.process.execPath,
          timeoutMs: request.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
        });
      })
    ).pipe(
      Stream.mapError((cause) => executionError("RouteKit Eval could not execute node:test.", cause))
    )
});
