import type { PlatformError } from "effect";

import { Effect, Queue, Ref, Stream } from "effect";
// `effect/unstable/process` is the only Effect-native way to spawn and stream a
// child process; there is no stable equivalent yet, so this depends on it
// deliberately.
import { ChildProcess } from "effect/unstable/process";

import type { CodexAdapterConfig } from "../config.ts";

import { buildCodexProcess } from "./process-config.ts";

import type { CodexDecodedLine } from "./protocol.ts";
import type { CodexRequestCommand } from "./schema.ts";

import {
  CodexMalformedLine,
  CodexProtocolError,
  decodeCodexLine,
  encodeCodexCommand,
} from "./protocol.ts";

type CodexIncoming = CodexDecodedLine | CodexMalformedLine;

const BYTES_PER_KIBIBYTE = 1024;
const BYTES_PER_MEBIBYTE = BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;
const MAX_JSONL_RECORD_LENGTH = BYTES_PER_MEBIBYTE;
const STDIN_QUEUE_CAPACITY = 16;
const LF_BYTE = 10;
const CR_BYTE = 13;
const emptyBytes = new Uint8Array();

interface CodexProcessTransport {
  readonly close: Effect.Effect<void>;
  readonly exit: Effect.Effect<number, PlatformError.PlatformError>;
  readonly incoming: Stream.Stream<
    CodexIncoming,
    PlatformError.PlatformError | CodexProtocolError
  >;
  readonly send: (
    id: number,
    command: CodexRequestCommand
  ) => Effect.Effect<void, CodexProtocolError>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly write: (line: string) => Effect.Effect<void>;
}

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

const oversizedRecord = (): CodexProtocolError =>
  new CodexProtocolError({ detail: "Codex JSONL record exceeds size limit" });

const splitLfByteRecords = Effect.fn(
  "CodexProcessTransport.splitLfByteRecords"
)(function* (buffer: Uint8Array, chunk: Uint8Array) {
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
      return yield* oversizedRecord();
    }
    records.push(record.at(-1) === CR_BYTE ? record.subarray(0, -1) : record);
    remainder = emptyBytes;
    start = index + 1;
  }
  const tail = appendBytes(remainder, chunk.subarray(start));
  const length = tail.length - (tail.at(-1) === CR_BYTE ? 1 : 0);
  if (length > MAX_JSONL_RECORD_LENGTH) {
    return yield* oversizedRecord();
  }
  return [tail, records] as const;
});

const decodeUtf8Record = (
  record: Uint8Array
): Effect.Effect<string, CodexProtocolError> =>
  Effect.try({
    catch: () =>
      new CodexProtocolError({
        detail: "Malformed UTF-8 in Codex JSONL record",
      }),
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(record),
  });

// A single undecodable record (bad JSON/UTF-8 or a modeled type whose payload
// no longer matches) becomes a `CodexMalformedLine` value rather than a stream
// failure, so one bad record is surfaced as a diagnostic downstream without
// tearing down the connection. Oversized records still fail (upstream, in
// `splitLfByteRecords`) because they signal a framing/limit breach.
const makeIncoming = (
  stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>
): Stream.Stream<
  CodexIncoming,
  PlatformError.PlatformError | CodexProtocolError
> =>
  stdout.pipe(
    Stream.mapAccumEffect(() => emptyBytes, splitLfByteRecords, {
      onHalt: (remainder) => (remainder.length > 0 ? [remainder] : []),
    }),
    Stream.filter((record) => record.length > 0),
    Stream.mapEffect((record) =>
      decodeUtf8Record(record).pipe(
        Effect.flatMap(decodeCodexLine),
        Effect.catchTag("CodexProtocolError", (error) =>
          Effect.succeed(new CodexMalformedLine({ detail: error.detail }))
        )
      )
    )
  );

const makeCodexProcessTransport = Effect.fn("CodexProcessTransport.make")(
  function* (adapterConfig: CodexAdapterConfig) {
    const config = buildCodexProcess(adapterConfig);
    const input = yield* Queue.bounded<Uint8Array>(STDIN_QUEUE_CAPACITY);
    const handle = yield* ChildProcess.make(config.command, config.args, {
      cwd: config.cwd,
      env: config.env,
      extendEnv: true,
      stderr: "pipe",
      stdin: Stream.fromQueue(input),
      stdout: "pipe",
    });
    const closed = yield* Ref.make(false);
    const close = Ref.getAndSet(closed, true).pipe(
      Effect.flatMap((wasClosed) =>
        wasClosed
          ? Effect.void
          : Queue.shutdown(input).pipe(Effect.andThen(handle.kill({})))
      ),
      Effect.ignore
    );
    const write = (line: string): Effect.Effect<void> =>
      Queue.offer(input, new TextEncoder().encode(line)).pipe(Effect.asVoid);
    const send = Effect.fn("CodexProcessTransport.send")(
      (id: number, command: CodexRequestCommand) =>
        encodeCodexCommand(id, command).pipe(Effect.flatMap(write))
    );
    return {
      close,
      // A signal kill resolves the exit code to `null`; `Number(null)` would
      // report a clean `0` exit, so map an absent code to -1 to keep a
      // signal-terminated process distinguishable from a real zero exit.
      exit: handle.exitCode.pipe(Effect.map((code) => code ?? -1)),
      incoming: makeIncoming(handle.stdout),
      send,
      stderr: handle.stderr,
      write,
    };
  }
);

export {
  makeCodexProcessTransport,
  MAX_JSONL_RECORD_LENGTH,
  STDIN_QUEUE_CAPACITY,
};
export type { CodexProcessTransport };
