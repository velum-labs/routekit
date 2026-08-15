import { Data, Deferred, Effect, Option, Ref, Schema } from "effect";

import type { PiNativeConnection } from "../native/connection.ts";
import type { PiExtensionUiRequest } from "../native/schema.ts";
import type {
  AcpAgentConnectionShape,
  AcpAgentRequestParams,
} from "../../../../../engine/acp-agent/src/service.ts";

import {
  AGENT_REQUEST_SCHEMAS,
  AGENT_RESULT_SCHEMAS,
} from "../../../../../contracts/internal/src/acp/protocol/profile.ts";

const ALLOW_ONCE_OPTION_ID = "allow-once";
const METHOD_NOT_FOUND = -32_601;
const REJECT_ONCE_OPTION_ID = "reject-once";

class PiPermissionResultError extends Data.TaggedError(
  "PiPermissionResultError"
)<{
  readonly detail: string;
}> {}

type ConfirmRequest = Extract<
  PiExtensionUiRequest,
  { readonly method: "confirm" }
>;

interface PermissionProjection {
  readonly method: "session/request_permission";
  readonly params: AcpAgentRequestParams<"session/request_permission">;
}

const projectPiPermission = (
  event: ConfirmRequest,
  sessionId: string
): PermissionProjection => ({
  method: "session/request_permission",
  params: {
    options: [
      {
        kind: "allow_once",
        name: "Allow once",
        optionId: ALLOW_ONCE_OPTION_ID,
      },
      {
        kind: "reject_once",
        name: "Reject",
        optionId: REJECT_ONCE_OPTION_ID,
      },
    ],
    sessionId,
    toolCall: {
      kind: "other",
      sessionUpdate: "tool_call_update",
      status: "pending",
      title: `${event.title}\n\n${event.message}`,
      toolCallId: event.id,
    },
  },
});

const projectAcpPermissionResult = Effect.fn("PiProjector.permissionResult")(
  function* (id: string, input: unknown) {
    const result = yield* Schema.decodeUnknownEffect(
      AGENT_RESULT_SCHEMAS["session/request_permission"]
    )(input).pipe(
      Effect.mapError(
        () =>
          new PiPermissionResultError({
            detail: "Pi permission result did not match the expected schema",
          })
      )
    );
    return {
      confirmed:
        result.outcome.outcome === "selected" &&
        result.outcome.optionId === ALLOW_ONCE_OPTION_ID,
      id,
      type: "extension_ui_response" as const,
    };
  }
);

const rejectNativePermission = (
  native: PiNativeConnection,
  event: ConfirmRequest
): Effect.Effect<void> =>
  native
    .respondToExtensionUi({
      confirmed: false,
      id: event.id,
      type: "extension_ui_response",
    })
    .pipe(Effect.ignore);

const handlePiPermission = Effect.fn("PiAdapter.handlePermission")(
  function* (
    state: {
      readonly agent: Deferred.Deferred<AcpAgentConnectionShape>;
      readonly currentSession: Ref.Ref<Option.Option<string>>;
      readonly native: PiNativeConnection;
      readonly onFailure: Effect.Effect<void>;
    },
    event: ConfirmRequest
  ) {
    const session = yield* Ref.get(state.currentSession);
    if (Option.isNone(session)) {
      return yield* rejectNativePermission(state.native, event);
    }
    const request = projectPiPermission(event, session.value);
    const connection = yield* Deferred.await(state.agent);
    const params = yield* Schema.decodeUnknownEffect(
      AGENT_REQUEST_SCHEMAS["session/request_permission"]
    )(request.params);
    const result = yield* connection.request(request.method, params);
    yield* state.native.respondToExtensionUi(
      yield* projectAcpPermissionResult(event.id, result)
    );
  },
  (effect, state, event) =>
    effect.pipe(
      Effect.onInterrupt(() => rejectNativePermission(state.native, event)),
      Effect.catch((error) =>
        rejectNativePermission(state.native, event).pipe(
          Effect.andThen(
            error._tag === "AcpAgentRemoteError" &&
              error.code === METHOD_NOT_FOUND
              ? Effect.void
              : state.onFailure
          )
        )
      )
    )
);

export { handlePiPermission, projectAcpPermissionResult, projectPiPermission };
