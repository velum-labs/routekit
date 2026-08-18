import { Data, Effect, Schema } from "effect";

import type { CodexAskUserRequest } from "../native/schema.ts";
import type { AcpAgentRequestParams } from "../../../../../engine/acp-agent/src/service.ts";

import { AGENT_RESULT_SCHEMAS } from "../../../../../contracts/internal/src/acp/protocol/profile.ts";

/** Raised when an ACP elicitation result does not match the shape its method
 * promised (an ACP-client response boundary, distinct from Codex native
 * events). */
class CodexElicitationResultError extends Data.TaggedError(
  "CodexElicitationResultError"
)<{
  readonly detail: string;
}> {}

interface ElicitationProjection {
  readonly method: "elicitation/create";
  readonly params: AcpAgentRequestParams<"elicitation/create">;
  readonly questionId: string;
}

const ValueContent = Schema.Struct({ value: Schema.String });

const decodeResult = <S extends Schema.Top>(
  schema: S,
  input: unknown
): Effect.Effect<
  S["Type"],
  CodexElicitationResultError,
  S["DecodingServices"]
> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () =>
        new CodexElicitationResultError({
          detail: "Codex elicitation result did not match the expected schema",
        })
    )
  );

// Codex can ask several questions (or a secret one) in a single request, but
// this adapter — like the previous Codex adapter — only bridges the common
// case of exactly one non-secret question through ACP as a free-text form;
// `options` on the question is intentionally discarded rather than modeled as
// a select, matching that prior behavior. Anything wider returns `undefined`
// so the caller can settle Codex with an empty answer instead of hanging it.
const projectCodexAskUser = (
  event: CodexAskUserRequest,
  sessionId?: string
): ElicitationProjection | undefined => {
  const [question, ...rest] = event.params.questions;
  if (question === undefined || rest.length > 0 || question.isSecret) {
    return;
  }
  return {
    method: "elicitation/create" as const,
    params: {
      message: question.question,
      mode: "form" as const,
      ...(sessionId === undefined
        ? { requestId: event.params.itemId }
        : { sessionId }),
      requestedSchema: {
        properties: {
          value: {
            title: question.header,
            type: "string" as const,
          },
        },
        required: ["value"],
        type: "object" as const,
      },
    },
    questionId: question.id,
  };
};

const projectAcpElicitationResult = Effect.fn(
  "CodexProjector.elicitationResult"
)(function* (input: unknown) {
  const result = yield* decodeResult(
    AGENT_RESULT_SCHEMAS["elicitation/create"],
    input
  );
  if (result.action !== "accept") {
    return [] as const;
  }
  const { value } = yield* decodeResult(ValueContent, result.content);
  return [value] as const;
});

export { projectAcpElicitationResult, projectCodexAskUser };
