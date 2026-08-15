import { Deferred, Effect, Option, Ref, Schema } from "effect";

import type { ThreadItem } from "../native/command-schema.ts";
import type { CodexNativeConnection } from "../native/connection.ts";
import type { CodexAdapterConfig } from "../config.ts";
import type {
  AcpClientCorrelatedResult,
  AcpClientKnownRequest,
} from "../../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { PromptTurn } from "../../../../../engine/acp-adapter-kit/src/prompt-turn.ts";
import type {
  AcpAgentConnectionShape,
  AcpClientRequestFailure,
} from "../../../../../engine/acp-agent/src/service.ts";

import { CodexNativeConnectionError } from "../native/connection.ts";
import { CodexVersionError } from "../errors.ts";

const INTERNAL_ERROR = -32_003;
type SessionLoadParams = Extract<
  AcpClientKnownRequest,
  { readonly method: "session/load" }
>["params"];

const failure = (
  message: string,
  code = INTERNAL_ERROR
): AcpClientRequestFailure => ({
  code,
  message,
});

const isKnownCodexError = (
  error: unknown
): error is CodexNativeConnectionError | CodexVersionError =>
  error instanceof CodexNativeConnectionError ||
  error instanceof CodexVersionError;

// A failed turn carries its reason as a plain `{ message }` object (see
// `finishPrompt` in adapter.ts), so the reason is decoded back out of that
// shape rather than collapsed into the generic fallback and lost.
const CarriedFailure = Schema.Struct({ message: Schema.String });
const decodeCarriedFailure = Schema.decodeUnknownOption(CarriedFailure);

const errorMessage = (error: unknown): string => {
  if (isKnownCodexError(error)) {
    return error.detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return Option.match(decodeCarriedFailure(error), {
    onNone: () => "Codex operation failed",
    onSome: ({ message }) => message,
  });
};

const asRequestFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, AcpClientRequestFailure, R> =>
  effect.pipe(Effect.mapError((error) => failure(errorMessage(error))));

interface SessionRefs {
  readonly currentSession: Ref.Ref<Option.Option<string>>;
  readonly currentNativeSession: Ref.Ref<Option.Option<string>>;
}

interface HandlerContext {
  readonly activePrompt: Ref.Ref<
    Option.Option<PromptTurn<{ readonly message: string }>>
  >;
  readonly agent: Deferred.Deferred<AcpAgentConnectionShape>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly model: CodexAdapterConfig["model"];
  readonly systemPrompt: CodexAdapterConfig["systemPrompt"];
  readonly native: CodexNativeConnection;
  readonly refs: SessionRefs;
}

const initializeResult = (): Effect.Effect<AcpClientCorrelatedResult> =>
  Effect.succeed({
    method: "initialize" as const,
    result: {
      agentCapabilities: {
        auth: {},
        loadSession: true,
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        promptCapabilities: {
          audio: false,
          embeddedContext: false,
          image: false,
        },
        sessionCapabilities: {},
      },
      agentInfo: {
        name: "routekit-eval-codex",
        version: "0.0.0",
      },
      authMethods: [],
      protocolVersion: 1 as const,
    },
  });

// Codex's own thread id becomes the ACP session id directly: unlike Pi's
// session-file path, it is already an opaque identifier Codex mints, so there
// is no private native path to keep off the wire (contrast Pi/Claude, which
// mint their own ACP-facing id to avoid ever exposing a native path).
const createSession = Effect.fn(function* (
  { model, native, refs, systemPrompt }: HandlerContext,
  params: Extract<
    AcpClientKnownRequest,
    { readonly method: "session/new" }
  >["params"]
) {
  const sessionId = yield* native.threadStart(params.cwd, model, systemPrompt);
  yield* Ref.set(refs.currentSession, Option.some(sessionId));
  yield* Ref.set(refs.currentNativeSession, Option.some(sessionId));
  return {
    method: "session/new" as const,
    result: { sessionId },
  };
}, asRequestFailure);

// Extracts an item's replayable text, or `undefined` for item types replay
// does not represent (tool calls, reasoning, etc.), matching how live-turn
// projection also only reports the item types it models.
const threadItemText = (
  item: ThreadItem
): { readonly text: string; readonly userMessage: boolean } | undefined => {
  if (item.type === "agentMessage") {
    if (item.text === undefined) {
      return undefined;
    }
    return {
      text: item.text,
      userMessage: false,
    };
  }
  if (item.type === "userMessage") {
    const text = (item.content ?? [])
      .map((content) => content.text ?? "")
      .join("");
    if (text.length === 0) {
      return undefined;
    }
    return {
      text,
      userMessage: true,
    };
  }
  return undefined;
};

// `thread/resume` reconstructs the thread's prior turns; replaying them as
// ACP session updates before `session/load` answers is what lets a resumed
// session render its history (mirrors the other adapters' own session-load
// replay, sourced here from Codex's own turn/item history instead of a
// separate transcript file).
const replayThreadHistory = Effect.fn(function* (
  connection: AcpAgentConnectionShape,
  sessionId: string,
  items: readonly ThreadItem[]
) {
  for (const item of items) {
    const projected = threadItemText(item);
    if (projected === undefined) {
      continue;
    }
    const sessionUpdate = projected.userMessage
      ? "user_message_chunk"
      : "agent_message_chunk";
    yield* connection.notify("session/update", {
      sessionId,
      update: {
        content: {
          text: projected.text,
          type: "text",
        },
        sessionUpdate,
      },
    });
  }
});

const loadSession = Effect.fn(function* (
  { agent, native, refs }: HandlerContext,
  params: SessionLoadParams
) {
  const history = yield* native.threadResume(params.sessionId);
  yield* Ref.set(refs.currentSession, Option.some(params.sessionId));
  yield* Ref.set(refs.currentNativeSession, Option.some(history.id));
  const connection = yield* Deferred.await(agent);
  yield* replayThreadHistory(connection, params.sessionId, history.items);
  return {
    method: "session/load" as const,
    result: {},
  };
}, asRequestFailure);

export { createSession, errorMessage, failure, initializeResult, loadSession };
export type { HandlerContext, SessionRefs };
