import type { PlatformError } from "effect";

import { Deferred, Effect, Queue, Redacted, Ref, Stream } from "effect";
// `effect/unstable/process` is the only Effect-native way to spawn and stream a
// child process; there is no stable equivalent yet, so this depends on it
// deliberately.
import { ChildProcess } from "effect/unstable/process";

const BYTES_PER_KIBIBYTE = 1024;
const BYTES_PER_MEBIBYTE = BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;
const LF_BYTE = 10;
const CR_BYTE = 13;
const emptyBytes = new Uint8Array();

/** The largest single JSONL record a native process may emit. */
export const MAX_JSONL_RECORD_LENGTH = BYTES_PER_MEBIBYTE;
/** How many encoded commands may be buffered towards the child's stdin. */
export const STDIN_QUEUE_CAPACITY = 16;

/**
 * One spawned native agent process, framed as JSONL in both directions. `Line`
 * is the adapter's decoded-or-recovered incoming union and `Command` its
 * outbound command union.
 */
export interface JsonlProcess<Line, Command, Err> {
  readonly close: Effect.Effect<void>;
  readonly exit: Effect.Effect<number, PlatformError.PlatformError>;
  readonly incoming: Stream.Stream<Line, PlatformError.PlatformError | Err>;
  readonly send: (command: Command) => Effect.Effect<void, Err>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
}

const processEnv = (
  env: Readonly<Record<string, Redacted.Redacted>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, Redacted.value(value)])
  );

const appendBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
};

/**
 * Splits a byte stream into LF-delimited records, carrying the unterminated
 * tail across chunks and tolerating CRLF. Oversized records fail the stream
 * (unlike undecodable ones) because they signal a framing or limit breach
 * rather than one bad payload.
 */
const makeSplitLfByteRecords = <Err>(input: {
  readonly onOversizedRecord: () => Err;
  readonly spanPrefix: string;
}): ((
  buffer: Uint8Array,
  chunk: Uint8Array
) => Effect.Effect<readonly [Uint8Array, readonly Uint8Array[]], Err>) =>
  Effect.fn(`${input.spanPrefix}.splitLfByteRecords`)(function* (
    buffer: Uint8Array,
    chunk: Uint8Array
  ) {
    const records: Uint8Array[] = [];
    let remainder = buffer;
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== LF_BYTE) {
        continue;
      }
      const record = appendBytes(remainder, chunk.subarray(start, index));
      const length = record.length - (record.at(-1) === CR_BYTE ? 1 : 0);
      if (length > MAX_JSONL_RECORD_LENGTH) {
        return yield* Effect.fail(input.onOversizedRecord());
      }
      records.push(record.at(-1) === CR_BYTE ? record.subarray(0, -1) : record);
      remainder = emptyBytes;
      start = index + 1;
    }
    const tail = appendBytes(remainder, chunk.subarray(start));
    const length = tail.length - (tail.at(-1) === CR_BYTE ? 1 : 0);
    if (length > MAX_JSONL_RECORD_LENGTH) {
      return yield* Effect.fail(input.onOversizedRecord());
    }
    return [tail, records] as const;
  });

/**
 * A single undecodable record (bad JSON/UTF-8 or a modeled type whose payload
 * no longer matches) becomes an adapter-owned malformed-line value rather than a
 * stream failure, so one bad record is surfaced as a diagnostic downstream
 * without tearing the connection down.
 */
const makeIncoming = <Line, Malformed, Err>(input: {
  readonly decodeLine: (line: string) => Effect.Effect<Line, Err>;
  readonly onMalformedLine: (error: Err) => Malformed;
  readonly onMalformedUtf8: () => Err;
  readonly onOversizedRecord: () => Err;
  readonly spanPrefix: string;
  readonly stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
}): Stream.Stream<Line | Malformed, PlatformError.PlatformError | Err> =>
  input.stdout.pipe(
    Stream.mapAccumEffect(
      () => emptyBytes,
      makeSplitLfByteRecords({
        onOversizedRecord: input.onOversizedRecord,
        spanPrefix: input.spanPrefix,
      }),
      { onHalt: (remainder) => (remainder.length > 0 ? [remainder] : []) }
    ),
    Stream.filter((record) => record.length > 0),
    Stream.mapEffect((record) =>
      Effect.try({
        catch: input.onMalformedUtf8,
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(record),
      }).pipe(
        Effect.flatMap(input.decodeLine),
        Effect.catch((error) => Effect.succeed(input.onMalformedLine(error)))
      )
    )
  );

const publishProcessExit =
  (publishedExit: Deferred.Deferred<number, PlatformError.PlatformError>) =>
  (code: number): Effect.Effect<void> =>
    Deferred.succeed(publishedExit, code).pipe(Effect.asVoid, Effect.ignore);

const failProcessExit =
  (publishedExit: Deferred.Deferred<number, PlatformError.PlatformError>) =>
  (error: PlatformError.PlatformError): Effect.Effect<void> =>
    Deferred.fail(publishedExit, error).pipe(Effect.asVoid, Effect.ignore);

const closeJsonlProcess = (input: {
  readonly closed: Ref.Ref<boolean>;
  readonly kill: Effect.Effect<void>;
  readonly publishExit: (code: number) => Effect.Effect<void>;
  readonly stdin: Queue.Queue<Uint8Array>;
}): Effect.Effect<void> =>
  Ref.getAndSet(input.closed, true).pipe(
    Effect.flatMap((wasClosed) =>
      wasClosed
        ? Effect.void
        : Queue.shutdown(input.stdin).pipe(
            // Unblock exit/stdout watchers before touching kill. Bun's kill /
            // exitCode can be uninterruptible after the child is already dead,
            // so never await them on the close path.
            Effect.andThen(input.publishExit(-1)),
            Effect.andThen(input.kill.pipe(Effect.forkDetach))
          )
    ),
    Effect.ignore
  );

const spawnJsonlChild = Effect.fn(function* (input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, Redacted.Redacted>>;
  readonly stdin: Queue.Queue<Uint8Array>;
}) {
  // Effect's acquireRelease awaits exit with no timeout unless this is set.
  // Bun can leave exit pending after a hard peer death; bound scope teardown.
  return yield* ChildProcess.make(input.command, input.args, {
    cwd: input.cwd,
    env: processEnv(input.env),
    extendEnv: true,
    forceKillAfter: "1 second",
    stderr: "pipe",
    stdin: Stream.fromQueue(input.stdin),
    stdout: "pipe",
  });
});

const observeProcessExit = (
  exitCode: Effect.Effect<number | null, PlatformError.PlatformError>,
  publishExit: (code: number) => Effect.Effect<void>,
  failExit: (error: PlatformError.PlatformError) => Effect.Effect<void>
): Effect.Effect<void> =>
  exitCode.pipe(
    Effect.map((code) => code ?? -1),
    Effect.flatMap(publishExit),
    Effect.catch(failExit),
    Effect.forkDetach,
    Effect.asVoid
  );

const makePublishedExit = Effect.fn(function* (
  exitCode: Effect.Effect<number | null, PlatformError.PlatformError>
) {
  const publishedExit = yield* Deferred.make<
    number,
    PlatformError.PlatformError
  >();
  const publishExit = publishProcessExit(publishedExit);
  yield* observeProcessExit(
    exitCode,
    publishExit,
    failProcessExit(publishedExit)
  );
  return {
    publishExit,
    publishedExit,
  };
});

/**
 * Both ACP provider adapters talk to their native agent over a spawned child
 * process framed as newline-delimited JSON, with the same bounded stdin queue,
 * the same idempotent close, and the same byte-level record framing. Only the
 * launch configuration, the line codec, and the error classes differ, so the
 * spine is bound once here.
 *
 * The caller keeps its own tracing span: this is an unnamed `Effect.fn`, so an
 * adapter's `Effect.fn("ClaudeProcess.spawn")` wrapper stays the span that shows
 * up in traces.
 */
export const makeJsonlProcess = Effect.fn(function* <
  Line,
  Malformed,
  Command,
  Err,
>(input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string | undefined;
  readonly decodeLine: (line: string) => Effect.Effect<Line, Err>;
  readonly encodeCommand: (command: Command) => Effect.Effect<string, Err>;
  readonly env: Readonly<Record<string, Redacted.Redacted>>;
  readonly onMalformedLine: (error: Err) => Malformed;
  readonly onMalformedUtf8: () => Err;
  readonly onOversizedRecord: () => Err;
  readonly spanPrefix: string;
}) {
  const stdin = yield* Queue.bounded<Uint8Array>(STDIN_QUEUE_CAPACITY);
  const handle = yield* spawnJsonlChild({
    args: input.args,
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    stdin,
  });
  const closed = yield* Ref.make(false);
  const { publishExit, publishedExit } = yield* makePublishedExit(
    handle.exitCode
  );
  // stdout and stderr are handed over unbounded on purpose. Cutting them off on
  // the child's exit would drop bytes still sitting in the pipe, and nothing in
  // teardown waits for them to end: the peer's exit loop fails in-flight
  // requests and the scope force-kills the child.
  return {
    close: closeJsonlProcess({
      closed,
      kill: handle.kill({}).pipe(Effect.ignore),
      publishExit,
      stdin,
    }),
    // A signal kill resolves the exit code to `null`; `Number(null)` would
    // report a clean `0` exit, so map an absent code to -1 to keep a
    // signal-terminated process distinguishable from a real zero exit.
    // Close publishes -1 when Bun never reports a code.
    exit: Deferred.await(publishedExit),
    incoming: makeIncoming({
      decodeLine: input.decodeLine,
      onMalformedLine: input.onMalformedLine,
      onMalformedUtf8: input.onMalformedUtf8,
      onOversizedRecord: input.onOversizedRecord,
      spanPrefix: input.spanPrefix,
      stdout: handle.stdout,
    }),
    send: Effect.fn(`${input.spanPrefix}.send`)((command: Command) =>
      input.encodeCommand(command).pipe(
        Effect.flatMap((line) =>
          Queue.offer(stdin, new TextEncoder().encode(line))
        ),
        Effect.asVoid
      )
    ),
    stderr: handle.stderr,
  };
});
