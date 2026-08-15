import type { Deferred, Effect, Option, PlatformError, Stream } from "effect";

import { Data } from "effect";

import type { PiMalformedLine, PiUnknownEvent } from "./protocol.ts";
import type {
  PiCommand,
  PiCommandType,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiKnownSessionEvent,
  PiSessionState,
  PiResponse,
} from "./schema.ts";

const PiNativeConnectionErrorReason = {
  CommandFailed: "command-failed",
  MalformedResponse: "malformed-response",
  PeerExit: "peer-exit",
  Shutdown: "shutdown",
} as const;
type PiNativeConnectionErrorReason =
  (typeof PiNativeConnectionErrorReason)[keyof typeof PiNativeConnectionErrorReason];

class PiNativeConnectionError extends Data.TaggedError(
  "PiNativeConnectionError"
)<{
  readonly detail: string;
  readonly reason: PiNativeConnectionErrorReason;
}> {}

const connectionError = (
  reason: PiNativeConnectionErrorReason,
  detail: string
): PiNativeConnectionError =>
  new PiNativeConnectionError({
    detail,
    reason,
  });

const NATIVE_EVENT_CAPACITY = 256;

type PiNativeEvent =
  | PiExtensionUiRequest
  | PiKnownSessionEvent
  | PiMalformedLine
  | PiUnknownEvent;

type PiRequestCommand = Exclude<PiCommand, PiExtensionUiResponse>;
type WithoutId<T> = T extends { readonly id?: string } ? Omit<T, "id"> : never;
type PiRequestInput = WithoutId<PiRequestCommand>;

interface PendingCommand {
  readonly command: PiCommandType;
  readonly deferred: Deferred.Deferred<PiResponse, PiNativeConnectionError>;
}

interface ConnectionState {
  readonly closed: Option.Option<PiNativeConnectionError>;
  readonly nextId: number;
  readonly pending: ReadonlyMap<string, PendingCommand>;
}

interface PiNativeConnection {
  readonly abort: Effect.Effect<void, PiNativeConnectionError>;
  readonly events: Stream.Stream<PiNativeEvent, PiNativeConnectionError>;
  readonly exit: Effect.Effect<number, PlatformError.PlatformError>;
  readonly getClosed: Effect.Effect<Option.Option<PiNativeConnectionError>>;
  readonly getState: Effect.Effect<PiSessionState, PiNativeConnectionError>;
  readonly getMessages: Effect.Effect<
    { readonly messages: readonly unknown[] },
    PiNativeConnectionError
  >;
  readonly getForkMessages: Effect.Effect<
    {
      readonly messages: readonly {
        readonly entryId: string;
        readonly text: string;
      }[];
    },
    PiNativeConnectionError
  >;
  readonly fork: (
    entryId: string
  ) => Effect.Effect<
    { readonly cancelled: boolean; readonly text?: string },
    PiNativeConnectionError
  >;
  readonly newSession: Effect.Effect<
    { readonly cancelled: boolean },
    PiNativeConnectionError
  >;
  readonly prompt: (
    message: string
  ) => Effect.Effect<void, PiNativeConnectionError>;
  readonly respondToExtensionUi: (
    response: PiExtensionUiResponse
  ) => Effect.Effect<void, PiNativeConnectionError>;
  readonly shutdown: Effect.Effect<void>;
  readonly stderr: Stream.Stream<Uint8Array, unknown>;
  readonly switchSession: (
    sessionPath: string
  ) => Effect.Effect<{ readonly cancelled: boolean }, PiNativeConnectionError>;
}

export {
  connectionError,
  NATIVE_EVENT_CAPACITY,
  PiNativeConnectionError,
  PiNativeConnectionErrorReason,
};
export type {
  ConnectionState,
  PiNativeConnection,
  PiNativeEvent,
  PiRequestInput,
};
