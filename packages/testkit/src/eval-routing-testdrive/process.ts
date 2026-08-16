import { buildChildEnv, terminateProcessGroup } from "@velum-labs/routekit-runtime";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { TestdriveProcessError } from "./contracts.js";

export interface TestdriveProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface TestdriveProcessService {
  readonly run: (
    command: string,
    args: readonly string[],
    options?: Readonly<{
      cwd?: string;
      env?: Readonly<Record<string, string | undefined>>;
      timeoutMs?: number;
    }>
  ) => Effect.Effect<TestdriveProcessResult, TestdriveProcessError, ChildProcessSpawner>;
}

export class TestdriveProcess extends Context.Service<TestdriveProcess, TestdriveProcessService>()(
  "@velum-labs/routekit-testkit/TestdriveProcess"
) {}

const safeCommandName = (command: string, args: readonly string[]): string =>
  [command.split("/").at(-1) ?? command, ...args.slice(0, 2)].join(" ");

export const TestdriveProcessLive: Layer.Layer<TestdriveProcess> = Layer.succeed(
  TestdriveProcess,
  TestdriveProcess.of({
    run: (command, args, options = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(command, [...args], {
            detached: true,
            env: options.env ?? buildChildEnv(),
            extendEnv: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            ...(options.cwd === undefined ? {} : { cwd: options.cwd })
          });
          const completed = Effect.all(
            [
              handle.exitCode,
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString)
            ],
            { concurrency: "unbounded" }
          );
          const [exitCode, stdout, stderr] = yield* options.timeoutMs === undefined
            ? completed
            : completed.pipe(
                Effect.timeoutOption(options.timeoutMs),
                Effect.flatMap((result) =>
                  Option.isSome(result)
                    ? Effect.succeed(result.value)
                    : Effect.fail(
                        new TestdriveProcessError({
                          command: safeCommandName(command, args),
                          detail: "process exceeded its testdrive timeout"
                        })
                      )
                )
              );
          if (Number(exitCode) !== 0) {
            return yield* new TestdriveProcessError({
              command: safeCommandName(command, args),
              detail:
                stderr.trim().length === 0
                  ? "process failed"
                  : "process failed with stderr withheld from durable evidence",
              exitCode: Number(exitCode)
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => terminateProcessGroup(Number(handle.pid), 5_000))
            );
          }
          return { exitCode: Number(exitCode), stdout };
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof TestdriveProcessError
              ? cause
              : new TestdriveProcessError({
                  command: safeCommandName(command, args),
                  detail: "process could not be executed"
                })
          )
        )
      ) as Effect.Effect<TestdriveProcessResult, TestdriveProcessError, ChildProcessSpawner>
  })
);
