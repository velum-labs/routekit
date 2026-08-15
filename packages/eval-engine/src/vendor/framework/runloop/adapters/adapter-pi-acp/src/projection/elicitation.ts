import { Data, Effect, Schema } from "effect";

import type { PiExtensionUiRequest } from "../native/schema.ts";
import type { AcpAgentRequestParams } from "../../../../../engine/acp-agent/src/service.ts";

import { ExtensionUiRequestKnown } from "../native/schema.ts";
import { AGENT_RESULT_SCHEMAS } from "../../../../../contracts/internal/src/acp/protocol/profile.ts";

class PiUnsupportedBlockingEventError extends Data.TaggedError(
  "PiUnsupportedBlockingEventError"
)<{
  readonly detail: string;
  readonly nativeEvent: string;
}> {}

/** Raised when an ACP elicitation result does not match the shape its method
 * promised (an ACP-client response boundary, distinct from Pi native events). */
class PiElicitationResultError extends Data.TaggedError(
  "PiElicitationResultError"
)<{
  readonly detail: string;
}> {}

const DialogMethod = Schema.Literals(["select", "confirm", "input", "editor"]);
const NonBlockingMethod = Schema.Literals([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);
const ValueContent = Schema.Struct({ value: Schema.String });
type SupportedDialogMethod = "input" | "select";
interface ElicitationProjection {
  readonly dialogMethod: SupportedDialogMethod;
  readonly method: "elicitation/create";
  readonly params: AcpAgentRequestParams<"elicitation/create">;
}

const decodeResult = <S extends Schema.Top>(
  schema: S,
  input: unknown
): Effect.Effect<S["Type"], PiElicitationResultError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () =>
        new PiElicitationResultError({
          detail: "Pi elicitation result did not match the expected schema",
        })
    )
  );

const property = (
  title: string,
  extra: Readonly<Record<string, Schema.Json>> = {}
): Readonly<Record<string, Schema.Json>> & {
  readonly title: string;
  readonly type: "string";
} => ({
  ...extra,
  title,
  type: "string" as const,
});
interface FormInput {
  readonly dialogMethod: SupportedDialogMethod;
  readonly id: string;
  readonly message: string;
  readonly name: string;
  readonly schema: Readonly<Record<string, Schema.Json>>;
  readonly sessionId?: string | undefined;
}

const form = ({
  dialogMethod,
  id,
  message,
  name,
  schema,
  sessionId,
}: FormInput): ElicitationProjection => ({
  dialogMethod,
  method: "elicitation/create" as const,
  params: {
    message,
    mode: "form" as const,
    ...(sessionId === undefined ? { requestId: id } : { sessionId }),
    requestedSchema: {
      properties: { [name]: schema },
      required: [name],
      type: "object" as const,
    },
  },
});

const unsupportedBlocking = (
  method: string,
  detail: string
): PiUnsupportedBlockingEventError =>
  new PiUnsupportedBlockingEventError({
    detail,
    nativeEvent: `extension_ui_request.${method}`,
  });

const projectPiElicitation = Effect.fn("PiProjector.elicitationRequest")(
  function* (
    event: PiExtensionUiRequest,
    sessionId?: string
  ): Effect.fn.Return<
    ElicitationProjection | undefined,
    PiUnsupportedBlockingEventError
  > {
    const { method } = event;
    if (Schema.is(NonBlockingMethod)(method)) {
      return;
    }
    if (!Schema.is(DialogMethod)(method)) {
      return yield* unsupportedBlocking(
        method,
        `Pi extension UI method is unsupported: ${method}`
      );
    }
    if (ExtensionUiRequestKnown.guards.select(event)) {
      return form({
        dialogMethod: "select",
        id: event.id,
        message: event.title,
        name: "value",
        schema: property(event.title, { enum: event.options }),
        sessionId,
      });
    }
    if (ExtensionUiRequestKnown.guards.input(event)) {
      return form({
        dialogMethod: "input",
        id: event.id,
        message: event.title,
        name: "value",
        schema: property(
          event.title,
          event.placeholder === undefined
            ? {}
            : { description: event.placeholder }
        ),
        sessionId,
      });
    }
    // `editor` (or a dialog method whose payload did not match a known variant)
    // is a blocking request ACP cannot represent: fail so the caller settles
    // the native peer instead of dropping it.
    return yield* unsupportedBlocking(
      method,
      `Pi extension UI method is unsupported: ${method}`
    );
  }
);

const projectAcpElicitationResult = Effect.fn("PiProjector.elicitationResult")(
  function* (method: SupportedDialogMethod, id: string, input: unknown) {
    const result = yield* decodeResult(
      AGENT_RESULT_SCHEMAS["elicitation/create"],
      input
    );
    if (result.action !== "accept") {
      return {
        cancelled: true as const,
        id,
        type: "extension_ui_response" as const,
      };
    }
    const { value } = yield* decodeResult(ValueContent, result.content);
    return {
      id,
      type: "extension_ui_response" as const,
      value,
    };
  }
);

export {
  PiUnsupportedBlockingEventError,
  projectAcpElicitationResult,
  projectPiElicitation,
};
