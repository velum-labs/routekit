import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Option, Ref, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { log } from "./logger.ts";
import { reapProcessGroup } from "./process-group.ts";

const EMPTY_COUNT = 0;
const EXECUTABLE_MODE = constants.X_OK;

interface HarnessProcessResult {
  readonly exitCode: number | null;
  /** Set when the binary is absent, so nothing was spawned. */
  readonly missingBinary?: boolean | undefined;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface HarnessProcessBinaryRequirement {
  readonly binaryEnvVar?: string | undefined;
  readonly installCommand: string;
}

const stdinFromString = (input: string): Stream.Stream<Uint8Array> =>
  Stream.succeed(input).pipe(Stream.encodeText);

interface RunningHarnessProcess {
  readonly handle: ChildProcessHandle;
  readonly stderrText: Effect.Effect<string, Error>;
}

const missingBinaryEvents = <State, Event>(
  input: StreamJsonlProcessInput<State, Event>,
  stderr: string
): Stream.Stream<Event> =>
  Stream.fromIterable(
    input.finalize(input.initialState, {
      exitCode: null,
      missingBinary: true,
      stderr,
      timedOut: false,
    })
  );

const executableCandidates = (
  binary: string,
  env: NodeJS.ProcessEnv
): readonly string[] => {
  if (isAbsolute(binary) || binary.includes("/")) {
    return [binary];
  }

  return (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length !== EMPTY_COUNT)
    .map((entry) => join(entry, binary));
};

const executableExists = (
  binary: string,
  env: NodeJS.ProcessEnv
): Effect.Effect<boolean, Error> =>
  Effect.promise(async () => {
    const candidates = executableCandidates(binary, env);
    for (const candidate of candidates) {
      try {
        await access(candidate, EXECUTABLE_MODE);
        return true;
      } catch {
        // keep searching PATH
      }
    }
    return false;
  });

const formatMissingHarnessProcessBinary = (
  binary: string,
  requirement: HarnessProcessBinaryRequirement
): string => {
  const location =
    isAbsolute(binary) || binary.includes("/")
      ? "at the configured path"
      : "on PATH";
  const configuredBinaryHint =
    requirement.binaryEnvVar === undefined
      ? ""
      : ` If it is already installed, set ${requirement.binaryEnvVar}.`;
  return `${binary} was not found ${location}. Install it with: ${requirement.installCommand}.${configuredBinaryHint}`;
};

const detectMissingHarnessProcessBinary = Effect.fn(
  "HarnessProcess.detectMissingHarnessProcessBinary"
)(function* (input: {
  readonly binary: string;
  readonly env: NodeJS.ProcessEnv;
  readonly missingBinary?: HarnessProcessBinaryRequirement | undefined;
}) {
  const exists = yield* executableExists(input.binary, input.env);
  if (exists || input.missingBinary === undefined) {
    return Option.none<string>();
  }

  return Option.some(
    formatMissingHarnessProcessBinary(input.binary, input.missingBinary)
  );
});

const normalizeLine = <State, Event>(
  stateRef: Ref.Ref<State>,
  input: StreamJsonlProcessInput<State, Event>,
  line: string
): Effect.Effect<readonly Event[]> =>
  Ref.modify(stateRef, (state) => {
    const [nextState, events] = input.normalizeLine(state, line);
    return [events, nextState];
  });

interface StreamJsonlProcessInput<State, Event> {
  readonly args: readonly string[];
  readonly binary: string;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly finalize: (
    state: State,
    result: HarnessProcessResult
  ) => readonly Event[];
  readonly initialState: State;
  readonly missingBinary?: HarnessProcessBinaryRequirement | undefined;
  readonly normalizeLine: (
    state: State,
    line: string
  ) => readonly [State, readonly Event[]];
  /**
   * Optional sink for the process's stderr, invoked once per line *as it arrives*
   * (3a / RFC 0011): the host forwards the binary's diagnostics live into
   * `routekit-eval logs`, not just the aggregated `stderr` on a non-zero exit. Best-effort
   * (a throw is swallowed so logging can never break the stream); when absent,
   * stderr is collected only for the error path. A plain function (RFC 0007).
   */
  readonly onStderrLine?: ((line: string) => void) | undefined;
  readonly prompt: string;
  readonly shouldSkipFinalize?: ((state: State) => boolean) | undefined;
  readonly timeoutMs?: number | undefined;
}

const toProcessError =
  (command: string) =>
  (cause: unknown): Error =>
    cause instanceof Error
      ? cause
      : new Error(`Failed to run ${command}: ${String(cause)}`);

const streamStdoutEvents = <State, Event>(input: {
  readonly input: StreamJsonlProcessInput<State, Event>;
  readonly running: RunningHarnessProcess;
  readonly stateRef: Ref.Ref<State>;
}): Stream.Stream<Event, Error> =>
  input.running.handle.stdout.pipe(
    Stream.mapError(toProcessError(input.input.binary)),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line) => line.trim()),
    Stream.filter((line) => line.length !== EMPTY_COUNT),
    Stream.mapEffect((line) =>
      normalizeLine(input.stateRef, input.input, line)
    ),
    Stream.flatMap((normalizedEvents) => Stream.fromIterable(normalizedEvents))
  );

const readProcessText = Effect.fn("HarnessProcess.readProcessText")(
  function* (input: {
    readonly command: string;
    readonly onLine?: (line: string) => void;
    readonly stream: Stream.Stream<Uint8Array, unknown>;
  }) {
    const decoded = input.stream.pipe(
      Stream.mapError(toProcessError(input.command)),
      Stream.decodeText()
    );
    if (input.onLine === undefined) {
      return yield* decoded.pipe(Stream.mkString);
    }
    const { onLine } = input;
    const lines: string[] = [];
    yield* decoded.pipe(
      Stream.splitLines,
      Stream.tap((line) =>
        Effect.sync(() => {
          lines.push(line);
          if (line.length === EMPTY_COUNT) {
            return;
          }
          try {
            onLine(line);
          } catch {
            /* swallow: logging must never break the stream */
          }
        })
      ),
      Stream.runDrain
    );
    return lines.join("\n");
  }
);

const spawnHarnessProcess = Effect.fn("HarnessProcess.spawn")(function* <
  State,
  Event,
>(input: StreamJsonlProcessInput<State, Event>) {
  const handle = yield* ChildProcess.make(input.binary, input.args, {
    cwd: input.cwd,
    // Own process group, so `reapProcessGroup` can signal the whole subtree.
    detached: true,
    env: input.env,
    extendEnv: false,
    stderr: "pipe",
    stdin: stdinFromString(input.prompt),
    stdout: "pipe",
  }).pipe(Effect.mapError(toProcessError(input.binary)));
  // Default to the process-global `log` (a no-op when uninstalled) so stderr is
  // still forwarded when no `onStderrLine` sink is supplied.
  const stderrSink =
    input.onStderrLine ??
    ((line: string): void => {
      log.child("harness", { binary: input.binary }).warn(line);
    });
  const stderrFiber = yield* readProcessText({
    command: input.binary,
    onLine: stderrSink,
    stream: handle.stderr,
  }).pipe(Effect.forkScoped);

  return {
    handle,
    stderrText: Fiber.join(stderrFiber),
  };
});

// Why the run terminated. The deadline fiber writes `Timeout` *before* it kills; the finalizer reads it so classification (deadline kill vs genuine exit) never depends on the runtime's error-shape.
type TerminationReason = "None" | "Timeout";
type TimeoutState = Ref.Ref<TerminationReason>;

const TIMED_OUT_EXIT = {
  exitCode: null,
  timedOut: true,
} as const;

// Grace before SIGTERM -> SIGKILL escalation; ceiling on the finalizer's stderr join. Both finite, so no misbehaving child can wedge the stream forever.
const KILL_GRACE = "1 second";
const STDERR_JOIN_GRACE = "5 seconds";

// Resolve the terminal exit, respecting the timeout latch. VERIFIED INVARIANT
// (Bun / @effect/platform-node-shared 4.0.0-beta.93): `handle.exitCode` succeeds
// with the code on a normal exit and *fails* with a `PlatformError` on signal
// death (`code === null`) — confirmed by reading `NodeChildProcessSpawner` and a
// live SIGTERM experiment. We never classify a timeout from that failure (the
// latch is authoritative); we only use it to know a post-deadline failure is benign.
const waitForProcessExit = Effect.fn("waitForProcessExit")(function* (
  command: string,
  handle: ChildProcessHandle,
  timedOutRef: TimeoutState
) {
  // Deadline already fired: the child was killed by us, so `handle.exitCode` would fail with the signal error — report the timeout directly.
  if ((yield* Ref.get(timedOutRef)) === "Timeout") {
    return TIMED_OUT_EXIT;
  }
  // Otherwise wait for a real exit. The deadline can still fire *during* this wait, failing `handle.exitCode` — re-read the latch on failure: `Timeout` = deadline kill; `None` = a real process error.
  return yield* handle.exitCode.pipe(
    Effect.map((exitCode) => ({
      exitCode: Number(exitCode),
      timedOut: false,
    })),
    Effect.catch((error) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(timedOutRef)) === "Timeout") {
          return TIMED_OUT_EXIT;
        }
        return yield* Effect.fail(toProcessError(command)(error));
      })
    )
  );
});

const finalizeProcess = Effect.fn("HarnessProcess.finalizeProcess")(function* <
  State,
  Event,
>(input: {
  readonly command: string;
  readonly handle: ChildProcessHandle;
  readonly input: StreamJsonlProcessInput<State, Event>;
  readonly stateRef: Ref.Ref<State>;
  readonly stderrText: Effect.Effect<string, Error>;
  readonly timedOutRef: TimeoutState;
}) {
  const exit = yield* waitForProcessExit(
    input.command,
    input.handle,
    input.timedOutRef
  );
  // Join the stderr collector, but never block indefinitely: a stderr fd leaked to a surviving grandchild would wedge the finalizer forever. On the grace ceiling fall back to empty so a terminal event is always emitted.
  const stderr = yield* input.stderrText.pipe(
    Effect.timeoutOrElse({
      duration: STDERR_JOIN_GRACE,
      orElse: () => Effect.succeed(""),
    })
  );
  const state = yield* Ref.get(input.stateRef);

  if (input.input.shouldSkipFinalize?.(state) === true) {
    return [];
  }

  return input.input.finalize(state, {
    exitCode: exit.exitCode,
    stderr,
    timedOut: exit.timedOut,
  });
});

const streamProcessFinalizer = <State, Event>(input: {
  readonly input: StreamJsonlProcessInput<State, Event>;
  readonly running: RunningHarnessProcess;
  readonly stateRef: Ref.Ref<State>;
  readonly timedOutRef: TimeoutState;
}): Stream.Stream<Event, Error> =>
  Stream.fromEffect(
    finalizeProcess({
      command: input.input.binary,
      handle: input.running.handle,
      input: input.input,
      stateRef: input.stateRef,
      stderrText: input.running.stderrText,
      timedOutRef: input.timedOutRef,
    })
  ).pipe(Stream.flatMap((finalEvents) => Stream.fromIterable(finalEvents)));

// The deadline fiber breaks the "hangs past its deadline" deadlock: it latches
// `Timeout` *before* it signals (so the finalizer sees the reason even if it
// wakes first), then kills so stdout closes and the single finalizer can run.
// The kill is an explicit SIGTERM -> SIGKILL escalation, NOT
// `handle.kill({ forceKillAfter })`, which in the Bun/node-shared spawner bounds
// only *sending* the signal, not the exit wait — so a SIGTERM-ignoring child is
// never escalated and it blocks forever (confirmed live). So fire SIGTERM as a
// child fiber whose uninterruptible kill-wait we join with a bound; on grace,
// send an untrappable SIGKILL. That reaps the child, resolving the spawner's
// exit Deferred so the timed-out SIGTERM fiber then settles cleanly (its
// `handle.kill` is `Effect.ignore`d, so it never surfaces an error either way).
const armTimeoutKill = Effect.fn("armTimeoutKill")(function* (
  handle: ChildProcessHandle,
  timeoutMs: number,
  timedOutRef: TimeoutState
) {
  yield* Effect.sleep(timeoutMs);
  yield* Ref.set(timedOutRef, "Timeout");
  const termFiber = yield* Effect.forkChild(
    handle.kill({}).pipe(Effect.ignore)
  );
  yield* Fiber.join(termFiber).pipe(
    Effect.timeoutOrElse({
      duration: KILL_GRACE,
      orElse: () => handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore),
    }),
    Effect.ignore
  );
});

const streamHarnessProcess = <State, Event>(input: {
  readonly input: StreamJsonlProcessInput<State, Event>;
  readonly running: RunningHarnessProcess;
  readonly stateRef: Ref.Ref<State>;
  readonly timedOutRef: TimeoutState;
}): Stream.Stream<Event, Error> =>
  streamStdoutEvents(input).pipe(Stream.concat(streamProcessFinalizer(input)));

const prepareJsonlProcessStream = Effect.fn(
  "HarnessProcess.prepareJsonlProcessStream"
)(function* <State, Event>(input: StreamJsonlProcessInput<State, Event>) {
  const stateRef = yield* Ref.make(input.initialState);
  const timedOutRef = yield* Ref.make<TerminationReason>("None");
  const missingBinaryError = yield* detectMissingHarnessProcessBinary(input);
  if (Option.isSome(missingBinaryError)) {
    return missingBinaryEvents(input, missingBinaryError.value);
  }

  const process = yield* spawnHarnessProcess(input);
  yield* Effect.addFinalizer(() => reapProcessGroup(process.handle.pid));
  // Arm the single deadline killer under this scope: `forkScoped` ties the timer
  // to the process scope so a clean early exit interrupts it (no orphaned timer).
  if (input.timeoutMs !== undefined) {
    yield* armTimeoutKill(process.handle, input.timeoutMs, timedOutRef).pipe(
      Effect.forkScoped
    );
  }
  return streamHarnessProcess({
    input,
    running: process,
    stateRef,
    timedOutRef,
  });
});

export const streamJsonlProcess = <State, Event>(
  input: StreamJsonlProcessInput<State, Event>
): Stream.Stream<Event, Error> =>
  Stream.scoped(Stream.unwrap(prepareJsonlProcessStream(input))).pipe(
    Stream.provide(NodeServicesLayer)
  );

export { detectMissingHarnessProcessBinary };
export type {
  HarnessProcessResult,
  HarnessProcessBinaryRequirement,
  StreamJsonlProcessInput,
};
