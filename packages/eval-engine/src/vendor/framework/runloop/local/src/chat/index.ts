import { Effect, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import type {
  Chat,
  ChatInteractionResponse,
  ChatSessionSummary,
  PersistedChatSessionSummary,
} from "../../../../contracts/author/src/index.ts";
import type { ChatOptions } from "./invoke.ts";

import { RuntimeClientError } from "../../../../contracts/internal/src/errors.ts";
import {
  fetchHttpClientLayer,
  isOkStatus,
} from "../../../../contracts/internal/src/http-client.ts";
import { RuntimeSessionSnapshotSchema } from "../../../../contracts/internal/src/runtime/session-snapshot.ts";
import {
  composeSteeringPrompt,
  invokeChatTurn,
  runtimeUrl,
  forkThreadTurn,
} from "./invoke.ts";
import {
  listPersistedRuntimeSessions,
  loadRuntimeSessionEvents,
} from "../daemon/logging/log-client.ts";

const HEALTH_CHECK_TIMEOUT = "5 seconds";
const INTERACTION_RESPONSE_PATH = "/api/interactions/respond";

const SessionsResponseSchema = Schema.Struct({
  sessions: Schema.Array(RuntimeSessionSnapshotSchema),
});

// The `Chat` contract (contracts/author/src/chat.ts) is Promise-based, so these
// helpers run their `HttpClient` effect on a bare runtime via `Effect.runPromise`
// rather than leaking Effect into the author-facing API. Each `runPromise` IS the
// composition root for that effect, so it provides `fetchHttpClientLayer` (the
// same fetch pin the rest of the codebase hoists to its roots) right at the
// boundary. `HttpClient` still surfaces in each effect's requirement channel;
// the boundary is simply where it is discharged.
const checkChatHealth = (
  options: Pick<ChatOptions, "host" | "port">
): Promise<void> =>
  // Wave-3 candidate: `checkChatHealth`'s caller (`runCliTui` in
  // `tui-session.ts`) DOES have an ambient `oriCliLayer` context; the fuller
  // hoist makes this return `Effect<void, RuntimeClientError, HttpClient>` and
  // drops the `runPromise`. That is a Promise->Effect shape change to an exported
  // function, which belongs to the Wave-3 RuntimeClient port PR, not edge #3.
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(runtimeUrl(options, "/health"));
      if (!isOkStatus(response.status)) {
        return yield* new RuntimeClientError({
          detail: `Health check failed with HTTP ${response.status}.`,
        });
      }
    }).pipe(
      // timeoutOrElse interrupts the in-flight request and its underlying fetch,
      // not just the surrounding effect.
      Effect.timeoutOrElse({
        duration: HEALTH_CHECK_TIMEOUT,
        orElse: () =>
          new RuntimeClientError({
            detail: "Health check timed out after 5 seconds.",
          }),
      }),
      Effect.provide(fetchHttpClientLayer)
    )
  );

const listSessions = (
  options: ChatOptions
): Promise<readonly ChatSessionSummary[]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(runtimeUrl(options, "/api/sessions"));
      if (!isOkStatus(response.status)) {
        const body = yield* response.text;
        return yield* new RuntimeClientError({
          detail: `Sessions request failed with HTTP ${response.status}: ${body}`,
        });
      }

      const payload = yield* response.json;
      const decoded = Schema.decodeUnknownSync(SessionsResponseSchema)(payload);
      return decoded.sessions.map((session) => ({
        completedTurns: session.completedTurns,
        failedTurns: session.failedTurns,
        lastEventType: session.lastEventType,
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
        // Lineage backref (Spawn Thread, RFC 0003) — present only on spawned threads.
        parentSessionId: session.parentSessionId,
      }));
    }).pipe(Effect.provide(fetchHttpClientLayer))
  );

const listPersistedSessions = (
  options: ChatOptions
): Promise<readonly PersistedChatSessionSummary[]> =>
  listPersistedRuntimeSessions({
    host: options.host,
    port: options.port,
  }).then((sessions) =>
    sessions.map((session) => ({
      completedTurns: session.completedTurns,
      endedAt: session.endedAt,
      failedTurns: session.failedTurns,
      latestPrompt: session.runIds.findLast(
        (run) => run.prompt !== undefined && run.prompt.length > 0
      )?.prompt,
      harness: session.harness,
      model:
        session.runIds.findLast(
          (run) => run.model !== null && run.model !== undefined
        )?.model ?? undefined,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
    }))
  );

// Needs only the endpoint, so the headless one-shot (`ori code --output
// jsonl`), which has no full ChatOptions, can settle interactions too.
const respondInteraction = (
  options: Pick<ChatOptions, "host" | "port">,
  input: ChatInteractionResponse
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(runtimeUrl(options, INTERACTION_RESPONSE_PATH), {
          body: HttpBody.jsonUnsafe(input),
        })
      );
      if (!isOkStatus(response.status)) {
        const body = yield* response.text;
        return yield* new RuntimeClientError({
          detail: `Interaction response failed with HTTP ${response.status}: ${body}`,
        });
      }
    }).pipe(Effect.provide(fetchHttpClientLayer))
  );

export const makeChat = (options: ChatOptions): Chat => {
  const resumedSessionId = options.sessionId;
  return {
    checkForUpdate: options.checkForUpdate,
    commands: options.commands,
    config: options.config,
    cwd: options.cwd,
    defaultHarness: options.defaultHarness ?? options.harnessName,
    defaultModel: options.defaultModel ?? options.model,
    defaultEffort: options.defaultEffort,
    harnessOverride: options.harnessName,
    modelOverride: options.model,
    initialPrompt: options.initialPrompt,
    initialSessionId: () => resumedSessionId,
    initialSessionProvisional: resumedSessionId === undefined,
    loadSessionEventsById: (sessionId) =>
      loadRuntimeSessionEvents(
        {
          host: options.host,
          port: options.port,
        },
        sessionId
      ),
    ...(resumedSessionId === undefined
      ? {}
      : {
          loadSessionEvents: () =>
            loadRuntimeSessionEvents(
              {
                host: options.host,
                port: options.port,
              },
              resumedSessionId
            ),
        }),
    listSessions: () => listSessions(options),
    listPersistedSessions: () => listPersistedSessions(options),
    logger: options.logger,
    respondInteraction: (input) => respondInteraction(options, input),
    sendMessage: (input) => invokeChatTurn(options, input),
    forkThread: (input) => forkThreadTurn(options, input),
    stores: options.stores,
    startupWarnings: options.startupWarnings,
    use: options.use,
    suggestions: options.suggestions,
  };
};

export {
  runtimeUrl,
  checkChatHealth,
  composeSteeringPrompt,
  respondInteraction,
};
export type { ChatOptions };
