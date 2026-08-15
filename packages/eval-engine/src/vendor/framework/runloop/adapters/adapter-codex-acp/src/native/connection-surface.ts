import { Effect, Stream } from "effect";

import type { ThreadItem } from "./command-schema.ts";
import type {
  CodexNativeConnectionError,
  CodexNativeEvent,
  CodexRequestFn,
  EventQueue,
} from "./connection-runtime.ts";
import type { CodexProcessTransport } from "./process-transport.ts";
import type { CodexAskUserRequest } from "./schema.ts";

import { connectionError } from "./connection-runtime.ts";
import { encodeCodexAskUserResponse } from "./protocol.ts";

interface CodexThreadHistory {
  readonly id: string;
  readonly items: readonly ThreadItem[];
}

interface CodexConnectionSurface {
  readonly events: Stream.Stream<CodexNativeEvent, CodexNativeConnectionError>;
  readonly exit: Effect.Effect<number, unknown>;
  readonly respondToAskUser: (
    id: CodexAskUserRequest["id"],
    questionId: string,
    answers: readonly string[]
  ) => Effect.Effect<void, CodexNativeConnectionError>;
  readonly shutdown: Effect.Effect<void>;
  readonly stderr: Stream.Stream<Uint8Array, unknown>;
  readonly threadResume: (
    threadId: string
  ) => Effect.Effect<CodexThreadHistory, CodexNativeConnectionError>;
  readonly threadStart: (
    cwd: string,
    model: string,
    developerInstructions?: string
  ) => Effect.Effect<string, CodexNativeConnectionError>;
  readonly turnInterrupt: (
    threadId: string,
    turnId: string
  ) => Effect.Effect<void, CodexNativeConnectionError>;
  readonly turnStart: (
    threadId: string,
    prompt: string
  ) => Effect.Effect<string, CodexNativeConnectionError>;
}

interface CodexConnectionSurfaceInput {
  readonly events: EventQueue;
  readonly request: CodexRequestFn;
  readonly shutdown: Effect.Effect<void>;
  readonly transport: CodexProcessTransport;
}

const makeRespondToAskUser =
  (transport: CodexProcessTransport) =>
  (
    id: CodexAskUserRequest["id"],
    questionId: string,
    answers: readonly string[]
  ): Effect.Effect<void, CodexNativeConnectionError> =>
    encodeCodexAskUserResponse(id, questionId, answers).pipe(
      Effect.mapError(() =>
        connectionError(
          "peer-exit",
          "Could not encode Codex user-input response"
        )
      ),
      Effect.flatMap((line) => transport.write(line))
    );

const makeThreadCommands = (
  request: CodexRequestFn
): Pick<
  CodexConnectionSurface,
  "threadResume" | "threadStart" | "turnInterrupt" | "turnStart"
> => ({
  threadResume: (
    threadId: string
  ): Effect.Effect<CodexThreadHistory, CodexNativeConnectionError> =>
    request({
      method: "thread/resume",
      params: { threadId },
    }).pipe(
      Effect.map((response) => ({
        id: response.thread.id,
        items: (response.thread.turns ?? []).flatMap((turn) => turn.items),
      }))
    ),
  threadStart: (
    cwd: string,
    model: string,
    developerInstructions?: string
  ): Effect.Effect<string, CodexNativeConnectionError> =>
    request({
      method: "thread/start",
      params: {
        cwd,
        ...(developerInstructions === undefined
          ? {}
          : { developerInstructions }),
        model,
      },
    }).pipe(Effect.map((response) => response.thread.id)),
  turnInterrupt: (
    threadId: string,
    turnId: string
  ): Effect.Effect<void, CodexNativeConnectionError> =>
    request({
      method: "turn/interrupt",
      params: {
        threadId,
        turnId,
      },
    }).pipe(Effect.asVoid),
  turnStart: (
    threadId: string,
    prompt: string
  ): Effect.Effect<string, CodexNativeConnectionError> =>
    request({
      method: "turn/start",
      params: {
        input: [
          {
            text: prompt,
            text_elements: [],
            type: "text",
          },
        ],
        threadId,
      },
    }).pipe(Effect.map((response) => response.turn.id)),
});

const makeCodexConnectionSurface = ({
  events,
  request,
  shutdown,
  transport,
}: CodexConnectionSurfaceInput): CodexConnectionSurface => ({
  events: Stream.fromQueue(events),
  exit: transport.exit,
  respondToAskUser: makeRespondToAskUser(transport),
  shutdown,
  stderr: transport.stderr,
  ...makeThreadCommands(request),
});

export { makeCodexConnectionSurface };
export type { CodexConnectionSurface };
