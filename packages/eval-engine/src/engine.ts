import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Stream } from "effect";

import {
  type EvalDiscovery,
  type EvalDiscoveryError,
  EvalDryRunError,
  type EvalDryRunSummary,
  type EvalEngineError,
  type EvalEngineEvent,
  type EvalEngineOptions,
  type EvalExecutionOptions,
  type EvalRunSummary,
  type EvalTargetOptions
} from "./model.js";
import { discoverEvalFiles } from "./routekit-eval/discovery.js";
import { executeNodeTests, isHealthyDryRun } from "./routekit-eval/node-test.js";
import { ensurePortableEvalImports } from "./routekit-eval/portable-imports.js";

export interface EvalEngineService {
  readonly discover: (
    options: EvalTargetOptions
  ) => Effect.Effect<EvalDiscovery, EvalDiscoveryError>;
  readonly list: (
    options: EvalTargetOptions
  ) => Effect.Effect<readonly string[], EvalDiscoveryError>;
  readonly dryRun: (
    options: EvalExecutionOptions
  ) => Stream.Stream<EvalEngineEvent, EvalEngineError>;
  readonly run: (options: EvalExecutionOptions) => Stream.Stream<EvalEngineEvent, EvalEngineError>;
}

export class EvalEngine extends Context.Service<EvalEngine, EvalEngineService>()(
  "@velum-labs/routekit-eval-engine/EvalEngine"
) {}

const provideNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(nodeServicesLayer));

const completedEmptyRun = (discovery: EvalDiscovery, dryRun: boolean): EvalEngineEvent => {
  if (dryRun) {
    return {
      _tag: "EvalDryRunCompleted",
      summary: {
        ...discovery,
        exitCode: 0,
        fileCount: 0,
        testCount: 0,
        tests: [],
        durationMs: 0,
        stdout: "",
        stderr: ""
      } satisfies EvalDryRunSummary
    };
  }
  return {
    _tag: "EvalRunCompleted",
    summary: {
      ...discovery,
      exitCode: 0,
      results: [],
      tests: [],
      durationMs: 0,
      stdout: "",
      stderr: ""
    } satisfies EvalRunSummary
  };
};

const execute = (
  engineOptions: EvalEngineOptions,
  options: EvalExecutionOptions,
  dryRun: boolean
): Stream.Stream<EvalEngineEvent, EvalEngineError> =>
  Stream.unwrap(
    provideNode(discoverEvalFiles(options)).pipe(
      Effect.map((discovery) => {
        const discovered: EvalEngineEvent = {
          _tag: "EvalDiscovered",
          discovery
        };
        if (discovery.files.length === 0) {
          return Stream.fromIterable([discovered, completedEmptyRun(discovery, dryRun)]);
        }
        const validate = provideNode(ensurePortableEvalImports(discovery.files));
        const started: EvalEngineEvent = {
          _tag: "EvalRunStarted",
          files: discovery.files,
          dryRun
        };
        const run = provideNode(
          executeNodeTests({
            nodeExecutable: engineOptions.nodeExecutable,
            environment: {
              ...(engineOptions.environment ?? {}),
              ...(options.environment ?? {})
            },
            cwd: discovery.workingDirectory,
            files: discovery.files,
            timeoutMs: options.timeoutMs ?? engineOptions.defaultTimeoutMs ?? 120_000,
            dryRun
          })
        ).pipe(
          Effect.flatMap((output) => {
            if (
              dryRun &&
              !isHealthyDryRun({
                files: discovery.files,
                exitCode: output.exitCode,
                output: `${output.stdout}${output.stderr}`,
                tests: output.tests
              })
            ) {
              return Effect.fail(
                new EvalDryRunError({
                  files: discovery.files,
                  exitCode: output.exitCode,
                  stdout: output.stdout,
                  stderr: output.stderr
                })
              );
            }
            const event: EvalEngineEvent = dryRun
              ? {
                  _tag: "EvalDryRunCompleted",
                  summary: {
                    ...discovery,
                    exitCode: 0,
                    fileCount: discovery.files.length,
                    testCount: 0,
                    tests: output.tests.map((test) => ({ ...test, status: "skipped" as const })),
                    durationMs: output.durationMs,
                    stdout: output.stdout,
                    stderr: output.stderr
                  }
                }
              : {
                  _tag: "EvalRunCompleted",
                  summary: {
                    ...discovery,
                    ...output
                  }
                };
            return Effect.succeed(event);
          })
        );
        return Stream.make(discovered).pipe(
          Stream.concat(Stream.fromEffect(validate).pipe(Stream.drain)),
          Stream.concat(Stream.make(started)),
          Stream.concat(Stream.fromEffect(run))
        );
      })
    )
  );

export const makeEvalEngineLayer = (options: EvalEngineOptions): Layer.Layer<EvalEngine> => {
  const discover = (target: EvalTargetOptions) => provideNode(discoverEvalFiles(target));
  return Layer.succeed(EvalEngine)(
    EvalEngine.of({
      discover,
      list: (target) => discover(target).pipe(Effect.map((result) => result.files)),
      dryRun: (target) => execute(options, target, true),
      run: (target) => execute(options, target, false)
    })
  );
};

export const discoverEvals = (
  options: EvalTargetOptions
): Effect.Effect<EvalDiscovery, EvalDiscoveryError, EvalEngine> =>
  Effect.gen(function* () {
    const engine = yield* EvalEngine;
    return yield* engine.discover(options);
  });

export const listEvals = (
  options: EvalTargetOptions
): Effect.Effect<readonly string[], EvalDiscoveryError, EvalEngine> =>
  Effect.gen(function* () {
    const engine = yield* EvalEngine;
    return yield* engine.list(options);
  });

export const dryRunEvals = (
  options: EvalExecutionOptions
): Stream.Stream<EvalEngineEvent, EvalEngineError, EvalEngine> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const engine = yield* EvalEngine;
      return engine.dryRun(options);
    })
  );

export const runEvals = (
  options: EvalExecutionOptions
): Stream.Stream<EvalEngineEvent, EvalEngineError, EvalEngine> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const engine = yield* EvalEngine;
      return engine.run(options);
    })
  );
