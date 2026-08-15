import { Effect, Schema, SchemaAST, Stream } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";

import type {
  AgentRuntimeEvent,
  ApiFeatureContext,
  ChatSuggestion,
  ChatTurnInput,
  CommandRouter,
  FeatureConfig,
  FeatureLogger,
  HarnessOutputSchema,
  ReasoningEffort,
  ForkThreadInput,
  StoreResolver,
  UpdateNotice,
} from "../../../../contracts/author/src/index.ts";
import type { InvokeRuntimeCommand } from "../../../../contracts/internal/src/runtime/command-types.ts";

import { RuntimeClientError } from "../../../../contracts/internal/src/errors.ts";
import {
  fetchHttpClientLayer,
  isOkStatus,
} from "../../../../contracts/internal/src/http-client.ts";
import {
  HarnessName,
  RuntimeCommandId,
  SessionId,
} from "../../../../contracts/internal/src/ids.ts";
import { decodeJsonLineSync } from "../../../../contracts/internal/src/json.ts";
import {
  RuntimeCommandTag,
  RuntimeStreamEventTag,
} from "../../../../contracts/internal/src/runtime/protocol.ts";
import { RuntimeStreamEventSchema } from "../../../../contracts/internal/src/runtime/stream-event.ts";
import { decodeRuntimeNdjsonLines } from "../daemon/client/client-http.ts";
import { runWithMissingSessionFallback } from "../event/resume-fallback.ts";

const EMPTY_COUNT = 0;
const ID_BYTE_LENGTH = 16;
const HEX_RADIX = 16;
const INVOKE_PATH = "/api/invoke";
const CANCEL_TIMEOUT = "500 millis";
const decodeRuntimeStreamEventLineSync = decodeJsonLineSync(
  RuntimeStreamEventSchema
);

interface ChatOptions {
  /** Pre-agent slash-command router surfaced via {@link Chat.commands} (RFC 0002 command.md). */
  readonly commands?: CommandRouter | undefined;
  /** Passive release update check surfaced via {@link Chat.checkForUpdate}. */
  readonly checkForUpdate?:
    | ((signal?: AbortSignal) => Promise<UpdateNotice | null>)
    | undefined;
  /** Feature-config resolver surfaced to the chat surface via {@link Chat.config} (RFC 0005 feature-config-access). */
  readonly config?: FeatureConfig | undefined;
  readonly cwd: string;
  /** Resolved default harness for display; falls back to {@link harnessName}. */
  readonly defaultHarness?: string | undefined;
  /** Resolved default model for display; falls back to {@link model}. */
  readonly defaultModel?: string | null | undefined;
  /** Built-in effort shown in the picker; the runtime applies its own default. */
  readonly defaultEffort?: ReasoningEffort | undefined;
  readonly featuresRoot?: string | undefined;
  readonly harnessName?: string | undefined;
  readonly host: string;
  /** Initial prompt from `--prompt`/`-p` or `--prompt-file`, surfaced via {@link Chat.initialPrompt} for auto-submit (RFC 0004 code.md / tui.md). */
  readonly initialPrompt?: string | undefined;
  /** True only when this caller can show and answer live interaction requests. */
  readonly interactionSurface?: boolean | undefined;
  /** Diagnostic logger surfaced to the chat surface via {@link Chat.logger} (RFC 0011). */
  readonly logger?: FeatureLogger;
  readonly model?: string | null | undefined;
  readonly port: number;
  readonly sessionId?: string | undefined;
  /** Store resolver surfaced to the chat surface via {@link Chat.stores} (RFC 0005). */
  readonly stores?: StoreResolver | undefined;
  /** Startup diagnostics surfaced by the chat UI after it mounts. */
  readonly startupWarnings?: readonly string[] | undefined;
  /** API export resolver surfaced to the chat surface via {@link Chat.use}. */
  readonly use?: ApiFeatureContext["use"] | undefined;
  /** Feature command and skill autocomplete rows surfaced via {@link Chat.suggestions} (RFC 0002 command.md / skill.md). */
  readonly suggestions?: readonly ChatSuggestion[] | undefined;
  readonly systemPrompt?: string | undefined;
  readonly telemetrySurface?: string | undefined;
}

const runtimeUrl = (
  options: Pick<ChatOptions, "host" | "port">,
  path: string
): string => `http://${options.host}:${options.port}${path}`;

const toHarnessOutputSchema = (
  output: Schema.ConstraintDecoder<unknown>
): HarnessOutputSchema => {
  const document = Schema.toJsonSchemaDocument(output);
  const hasDefinitions = Object.keys(document.definitions).length > EMPTY_COUNT;
  const name =
    SchemaAST.resolveIdentifier(output.ast) ??
    SchemaAST.resolveTitle(output.ast);
  return {
    ...(hasDefinitions ? { definitions: document.definitions } : {}),
    name,
    schema: document.schema,
  };
};

const makeId = (): string => {
  const bytes = new Uint8Array(ID_BYTE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, "0"))
    .join("");
};

// Harness-neutral by design: it does not rely on the underlying binary having
// flushed the aborted turn to its resumable transcript, which pi does not do for
// a turn killed before a message/tool boundary. A blank/whitespace `priorPartial`
// is treated as absent so a steer with nothing captured yet is a plain turn.
const composeSteeringPrompt = (
  priorPartial: string | undefined,
  prompt: string
): string => {
  const trimmedPartial = priorPartial?.trim();
  if (trimmedPartial === undefined || trimmedPartial.length === EMPTY_COUNT) {
    return prompt;
  }
  return [
    "I interrupted your previous turn to steer you in a new direction.",
    "Here is the partial work you had produced before I interrupted:",
    "",
    trimmedPartial,
    "",
    "Take that partial work into account, then follow this new instruction:",
    "",
    prompt,
  ].join("\n");
};

const makeInvokeCommand = (
  options: ChatOptions,
  input: ChatTurnInput
): InvokeRuntimeCommand => {
  const harnessName = input.harness ?? options.harnessName;
  const model = input.model === undefined ? options.model : input.model;
  const systemPrompt = input.systemPrompt ?? options.systemPrompt;

  return {
    commandId: RuntimeCommandId.make(makeId()),
    cwd: options.cwd,
    prompt: composeSteeringPrompt(input.priorPartial, input.prompt),
    type: RuntimeCommandTag.InvokeAgent,
    env: input.env,
    parameters: input.parameters,
    featuresRoot: options.featuresRoot,
    telemetrySurface: options.telemetrySurface,
    ...(options.interactionSurface === true
      ? { interactionSurface: true }
      : {}),
    ...(input.forceRollover === true ? { forceRollover: true } : {}),
    ...(harnessName === undefined
      ? {}
      : { harnessName: HarnessName.make(harnessName) }),
    model,
    ...(input.output === undefined
      ? {}
      : { outputSchema: toHarnessOutputSchema(input.output) }),
    ...(input.sessionId === undefined
      ? {}
      : { sessionId: SessionId.make(input.sessionId) }),
    systemPrompt,
  };
};

// Carries the `fork` directive and NO sessionId — the daemon mints the child.
const makeForkCommand = (
  options: ChatOptions,
  input: ForkThreadInput
): InvokeRuntimeCommand => {
  const harnessName = input.harness ?? options.harnessName;
  const model = input.model === undefined ? options.model : input.model;
  const systemPrompt = input.systemPrompt ?? options.systemPrompt;

  return {
    commandId: RuntimeCommandId.make(makeId()),
    cwd: options.cwd,
    prompt: input.prompt,
    fork: { parentSessionId: SessionId.make(input.parentSessionId) },
    type: RuntimeCommandTag.InvokeAgent,
    env: input.env,
    parameters: input.parameters,
    featuresRoot: options.featuresRoot,
    ...(harnessName === undefined
      ? {}
      : { harnessName: HarnessName.make(harnessName) }),
    model,
    systemPrompt,
    telemetrySurface: options.telemetrySurface,
  };
};

// Mirrors the prior `fetch({ signal })` behavior (RFC 0005 run steering / ESC):
// aborting cancels the underlying request mid-stream rather than merely dropping
// subsequent events. Absent signal → never interrupts.
const ABORTED = "aborted" as const;

const abortInterrupt = (
  signal: AbortSignal | undefined
): Effect.Effect<typeof ABORTED> => {
  if (signal === undefined) {
    return Effect.never;
  }
  if (signal.aborted) {
    return Effect.succeed(ABORTED);
  }
  return Effect.callback<typeof ABORTED>((resume) => {
    const onAbort = (): void => {
      resume(Effect.succeed(ABORTED));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
};

const cancelInvoke = Effect.fn("ChatInvoke.cancelInvoke")(function* (
  options: ChatOptions,
  command: InvokeRuntimeCommand
) {
  const client = yield* HttpClient.HttpClient;
  yield* client
    .execute(
      HttpClientRequest.post(
        runtimeUrl(
          options,
          `${INVOKE_PATH}/${encodeURIComponent(command.commandId)}/cancel`
        )
      )
    )
    .pipe(Effect.timeout(CANCEL_TIMEOUT), Effect.ignore);
});

// Exported so the abort-to-daemon request seam can be tested without a live daemon.
export const abortWithDaemonCancel = (
  options: ChatOptions,
  command: InvokeRuntimeCommand,
  signal: AbortSignal | undefined
): Effect.Effect<typeof ABORTED, never, HttpClient.HttpClient> => {
  if (signal === undefined) {
    return Effect.never;
  }
  return Effect.gen(function* () {
    yield* abortInterrupt(signal);
    yield* cancelInvoke(options, command);
    return ABORTED;
  });
};

const invokeCommandStream = (
  options: ChatOptions,
  command: InvokeRuntimeCommand,
  signal: AbortSignal | undefined
): Stream.Stream<AgentRuntimeEvent, Error> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(runtimeUrl(options, INVOKE_PATH), {
          body: HttpBody.jsonUnsafe(command),
        })
      );

      if (!isOkStatus(response.status)) {
        const body = yield* response.text;
        return yield* new RuntimeClientError({
          detail: `Invoke failed with HTTP ${response.status}: ${body}`,
        });
      }

      return decodeRuntimeNdjsonLines(response.stream).pipe(
        Stream.map((line) => decodeRuntimeStreamEventLineSync(line)),
        Stream.flatMap((streamEvent) =>
          streamEvent.type === RuntimeStreamEventTag.RuntimeEvent
            ? Stream.succeed(streamEvent.event)
            : Stream.empty
        )
      );
    })
  ).pipe(
    Stream.interruptWhen(abortWithDaemonCancel(options, command, signal)),
    // The `Chat` contract is Promise/AsyncGenerator-based (this stream is
    // consumed via `Stream.toAsyncIterable` on a bare runtime), so this is the
    // stream's composition root: discharge `HttpClient` here with the canonical
    // fetch pin rather than leaking Effect to callers.
    Stream.provide(fetchHttpClientLayer),
    // Collapse transport/decoding failures (HttpClientError, SchemaError) into a
    // plain `Error`, matching the message shape the async generator used to
    // throw so `Stream.toAsyncIterable` rejects identically. A bare
    // HttpClientError reads as an opaque "Decode error (200 POST …)" when the
    // runtime drops the NDJSON body mid-turn, so name the failing stream.
    Stream.mapError((cause) => {
      if (HttpClientError.isHttpClientError(cause)) {
        return new Error(
          `Runtime event stream from ${runtimeUrl(options, INVOKE_PATH)} failed mid-turn (${cause.message}). The local RouteKitEval runtime may have crashed or restarted; check routekit-eval start logs and retry.`,
          { cause }
        );
      }
      return cause instanceof Error ? cause : new Error(String(cause));
    })
  );

// Shared by normal turns and fork-thread so both go through exactly one
// request/stream path. Bridged back to the `AsyncGenerator` the `Chat` contract
// (and `runWithMissingSessionFallback`) expect; a stream failure throws out of
// the `for await`, matching the prior thrown-error behavior.
const postInvokeCommand = async function* (
  options: ChatOptions,
  command: InvokeRuntimeCommand,
  signal: AbortSignal | undefined
): AsyncGenerator<AgentRuntimeEvent> {
  yield* Stream.toAsyncIterable(invokeCommandStream(options, command, signal));
};

const invokeRuntimeTurn = (
  options: ChatOptions,
  input: ChatTurnInput
): AsyncGenerator<AgentRuntimeEvent> =>
  postInvokeCommand(options, makeInvokeCommand(options, input), input.signal);

const forkThreadTurn = (
  options: ChatOptions,
  input: ForkThreadInput
): AsyncGenerator<AgentRuntimeEvent> =>
  postInvokeCommand(options, makeForkCommand(options, input), input.signal);

const invokeChatTurn = async function* (
  options: ChatOptions,
  input: ChatTurnInput
): AsyncGenerator<AgentRuntimeEvent> {
  if (input.sessionId !== undefined) {
    // A resume turn: guard it with the missing-session fallback, which retries
    // as a fresh session (no sessionId) if the harness rejects the resume id.
    yield* runWithMissingSessionFallback(
      invokeRuntimeTurn(options, input),
      () =>
        invokeRuntimeTurn(options, {
          ...input,
          sessionId: undefined,
        })
    );
    return;
  }

  yield* invokeRuntimeTurn(options, input);
};

export { composeSteeringPrompt, invokeChatTurn, runtimeUrl, forkThreadTurn };
export type { ChatOptions };
