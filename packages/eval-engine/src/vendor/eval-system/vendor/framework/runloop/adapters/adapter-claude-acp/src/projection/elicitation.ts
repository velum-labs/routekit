import { Data, Effect, Schema } from "effect";

import type {
  AskUserControlResponseType,
  ClaudeControlRequest,
} from "../native/schema.ts";
import type { AcpAgentRequestParams } from "../../../../../engine/acp-agent/src/service.ts";

import { AskUserControlRequest } from "../native/schema.ts";
import { AGENT_RESULT_SCHEMAS } from "../../../../../contracts/internal/src/acp/protocol/profile.ts";

/** Raised when a Claude control_request cannot be represented as an ACP form
 * elicitation (a permission subtype or a non-AskUserQuestion tool). */
class ClaudeUnsupportedElicitationError extends Data.TaggedError(
  "ClaudeUnsupportedElicitationError"
)<{
  readonly detail: string;
  readonly nativeEvent: string;
}> {}

/** Raised when an ACP elicitation result does not match the shape its method
 * promised (an ACP-client response boundary, distinct from native events). */
class ClaudeElicitationResultError extends Data.TaggedError(
  "ClaudeElicitationResultError"
)<{
  readonly detail: string;
}> {}

// The single string answer the form elicitation collects, mirrored back to
// Claude as the AskUserQuestion control_response.
const ValueContent = Schema.Struct({ value: Schema.String });

const isAskUserRequest = Schema.is(AskUserControlRequest);

interface ElicitationProjection {
  readonly method: "elicitation/create";
  readonly params: AcpAgentRequestParams<"elicitation/create">;
}

interface FormInput {
  readonly id: string;
  readonly message: string;
  readonly options: readonly string[];
  readonly sessionId?: string | undefined;
}

const form = ({
  id,
  message,
  options,
  sessionId,
}: FormInput): ElicitationProjection => ({
  method: "elicitation/create" as const,
  params: {
    message,
    mode: "form" as const,
    // The elicitation targets the active session when there is one, and the
    // native request id otherwise; ACP accepts either, never both.
    ...(sessionId === undefined ? { requestId: id } : { sessionId }),
    requestedSchema: {
      properties: {
        value: {
          enum: options,
          title: message,
          type: "string" as const,
        },
      },
      required: ["value"],
      type: "object" as const,
    },
  },
});

// Claude's only blocking client interaction over the private stream is the
// AskUserQuestion control_request. Anything else (permission subtypes, other
// can_use_tool tools) is not representable as a form and is rejected so the
// form-only handler never receives it.
const projectClaudeElicitation = Effect.fn(
  "ClaudeProjector.elicitationRequest"
)(function* (event: ClaudeControlRequest, sessionId?: string) {
  if (isAskUserRequest(event)) {
    const [question] = event.request.input.questions;
    if (question === undefined) {
      return yield* new ClaudeUnsupportedElicitationError({
        detail: "Claude AskUserQuestion carried no questions",
        nativeEvent: "control_request.can_use_tool",
      });
    }
    const message =
      question.header === undefined
        ? question.question
        : `${question.header}\n\n${question.question}`;
    return form({
      id: event.request_id,
      message,
      options: question.options.map((option) => option.label),
      sessionId,
    });
  }
  if (event.request.subtype !== "can_use_tool") {
    return yield* new ClaudeUnsupportedElicitationError({
      detail: `Claude control_request subtype is unsupported: ${event.request.subtype}`,
      nativeEvent: `control_request.${event.request.subtype}`,
    });
  }
  // e.g. URL/permission tool requests: not representable as a form, so the
  // form-only elicitation handler must never see them.
  const toolName = event.request.tool_name ?? "unknown";
  return yield* new ClaudeUnsupportedElicitationError({
    detail: `Claude can_use_tool request is unsupported: ${toolName}`,
    nativeEvent: `control_request.can_use_tool.${toolName}`,
  });
});

const projectAcpElicitationResult = Effect.fn(
  "ClaudeProjector.elicitationResult"
)(function* (requestId: string, input: unknown) {
  const result = yield* Schema.decodeUnknownEffect(
    AGENT_RESULT_SCHEMAS["elicitation/create"]
  )(input).pipe(
    Effect.mapError(
      () =>
        new ClaudeElicitationResultError({
          detail: "ACP elicitation result did not match the expected schema",
        })
    )
  );
  if (result.action !== "accept") {
    return {
      request_id: requestId,
      response: { subtype: "cancelled" as const },
      type: "control_response" as const,
    } satisfies AskUserControlResponseType;
  }
  const answer = yield* Schema.decodeUnknownEffect(ValueContent)(
    result.content
  ).pipe(
    Effect.mapError(
      () =>
        new ClaudeElicitationResultError({
          detail: "Accepted ACP elicitation result is invalid for Claude",
        })
    )
  );
  return {
    request_id: requestId,
    response: {
      response: answer.value,
      subtype: "success" as const,
    },
    type: "control_response" as const,
  } satisfies AskUserControlResponseType;
});

export {
  ClaudeUnsupportedElicitationError,
  projectAcpElicitationResult,
  projectClaudeElicitation,
};
