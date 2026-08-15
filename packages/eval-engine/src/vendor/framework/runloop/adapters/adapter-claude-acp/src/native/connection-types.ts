import type {
  Effect,
  Fiber,
  Option,
  PlatformError,
  Queue,
  Ref,
  Stream,
} from "effect";

import { Data } from "effect";

import type { ClaudeProcess } from "./process-transport.ts";
import type { ClaudeMalformedLine, ClaudeUnknownEvent } from "./protocol.ts";
import type { AskUserControlResponseType, ClaudeInbound } from "./schema.ts";
import type {
  ClaudeTranscriptMessage,
  TranscriptRef,
} from "./transcript.ts";

const ClaudeNativeConnectionErrorReason = {
  MalformedResponse: "malformed-response",
  NoActiveSession: "no-active-session",
  PeerExit: "peer-exit",
  Shutdown: "shutdown",
} as const;
type ClaudeNativeConnectionErrorReason =
  (typeof ClaudeNativeConnectionErrorReason)[keyof typeof ClaudeNativeConnectionErrorReason];

class ClaudeNativeConnectionError extends Data.TaggedError(
  "ClaudeNativeConnectionError"
)<{
  readonly detail: string;
  readonly reason: ClaudeNativeConnectionErrorReason;
}> {}

// A terminal `result` maps to this end-of-turn marker so the handler settles.
const AGENT_END = { type: "agent_end" } as const;
type ClaudeNativeEvent =
  | ClaudeInbound
  | ClaudeMalformedLine
  | ClaudeUnknownEvent
  | typeof AGENT_END;

const NATIVE_EVENT_CAPACITY = 256;

interface ClaudeSessionState {
  readonly autoCompactionEnabled: boolean;
  readonly sessionId: string;
}

type ConnectionResult<A> = Effect.Effect<A, ClaudeNativeConnectionError>;
type EventStream = Stream.Stream<
  ClaudeNativeEvent,
  ClaudeNativeConnectionError
>;

interface ClaudeNativeConnection {
  readonly abort: ConnectionResult<void>;
  readonly events: EventStream;
  readonly exit: Effect.Effect<number, PlatformError.PlatformError>;
  readonly getState: ConnectionResult<ClaudeSessionState>;
  readonly getMessages: ConnectionResult<{
    readonly messages: readonly ClaudeTranscriptMessage[];
  }>;
  readonly newSession: ConnectionResult<{ readonly cancelled: boolean }>;
  readonly prompt: (message: string) => ConnectionResult<void>;
  readonly respondToAskUser: (
    response: AskUserControlResponseType
  ) => ConnectionResult<void>;
  readonly shutdown: Effect.Effect<void>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly switchSession: (
    sessionId: string
  ) => ConnectionResult<{ readonly cancelled: boolean }>;
}

interface ConnectionState {
  readonly active: Option.Option<ClaudeProcess>;
  readonly closed: boolean;
  readonly drain: Option.Option<Fiber.Fiber<void>>;
}

type ConnectionRef = Ref.Ref<ConnectionState>;
type EventQueue = Queue.Queue<ClaudeNativeEvent>;

interface ConnectionCore {
  readonly events: EventQueue;
  readonly state: ConnectionRef;
  // Connection-lived so a single drain observes stderr from every spawned
  // process; per-process streams come and go as sessions switch.
  readonly stderr: Queue.Queue<Uint8Array>;
  readonly transcripts: TranscriptRef;
}

interface StartupInput {
  readonly sessionId: string;
  readonly type: "create" | "load";
}

type StartProcessFn = (
  startup: StartupInput
) => Effect.Effect<
  ClaudeProcess,
  ClaudeNativeConnectionError | PlatformError.PlatformError
>;

const connectionError = (
  reason: ClaudeNativeConnectionErrorReason,
  detail: string
): ClaudeNativeConnectionError =>
  new ClaudeNativeConnectionError({
    detail,
    reason,
  });

export {
  AGENT_END,
  ClaudeNativeConnectionError,
  ClaudeNativeConnectionErrorReason,
  connectionError,
  NATIVE_EVENT_CAPACITY,
};
export type {
  ClaudeNativeConnection,
  ClaudeNativeEvent,
  ConnectionCore,
  ConnectionRef,
  ConnectionResult,
  ConnectionState,
  EventQueue,
  StartProcessFn,
  StartupInput,
};
