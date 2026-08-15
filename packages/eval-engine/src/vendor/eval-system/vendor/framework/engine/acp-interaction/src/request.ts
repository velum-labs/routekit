import { Schema } from "effect";

import type { ElicitationFieldSummary } from "../../../contracts/author/src/agent-event.ts";
import type { AcpAgentKnownRequest } from "../../../contracts/internal/src/acp/protocol/profile.ts";
import type { RegisterInput } from "../../interaction/src/model.ts";

import { CreateElicitationFormParams } from "../../../contracts/internal/src/acp/protocol/methods/elicitation.ts";
import { SessionId } from "../../../contracts/internal/src/ids.ts";

import { buildAcceptValidator, fieldOptionsOf, fieldTypeOf } from "./content.ts";

type FormParams = typeof CreateElicitationFormParams.Type;
type ElicitationFieldDefault = Exclude<
  ElicitationFieldSummary["default"],
  undefined
>;

// The wire `elicitation/create` params union carries an opaque catch-all whose
// `mode` is a bare `string`, so it overlaps the `"form"` literal and leaks
// through a plain `mode !== "form"` check. Decode-based recognition narrows to
// exactly the form variant (session- or request-scoped) and rejects url and
// unknown modes. The predicate is pinned to the clean decoded `FormParams` so
// the narrowed value is the struct union, not an intersection with the opaque
// variant's `Record<string, Json>` rest.
const isFormParams: (
  params: ElicitationRequest["params"]
) => params is FormParams = Schema.is(CreateElicitationFormParams);

type PermissionRequest = Extract<
  AcpAgentKnownRequest,
  { readonly method: "session/request_permission" }
>;
type ElicitationRequest = Extract<
  AcpAgentKnownRequest,
  { readonly method: "elicitation/create" }
>;

/**
 * Project a `session/request_permission` wire request into the S2 register
 * input. `operation` is the tool-call *kind* (a fixed vocabulary literal like
 * `edit`), never the human title or raw input, so the journaled requested event
 * stays free of paths and payloads (RFC 0003, "Permission requests"). Every
 * offered `{ optionId, kind }` is kept so the service can validate a selected
 * option against exactly what was offered.
 */
export const projectPermission = (
  request: PermissionRequest
): RegisterInput => {
  const { params } = request;
  return {
    kind: "permission",
    operation: params.toolCall.kind ?? "tool_call",
    options: params.options.map((option) => ({
      kind: option.kind,
      optionId: option.optionId,
    })),
    sessionId: SessionId.make(params.sessionId),
    toolCallId: params.toolCall.toolCallId,
  };
};

export type ProjectedElicitation =
  | { readonly input: RegisterInput; readonly type: "register" }
  | { readonly type: "unsupported-mode" }
  | { readonly type: "unsupported-scope" };

const elicitationDefault = (
  value: unknown
): ElicitationFieldDefault | undefined => {
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  ) {
    return value;
  }
  return undefined;
};

const summarizeFields = (
  requestedSchema: Extract<
    ElicitationRequest["params"],
    { readonly mode: "form" }
  >["requestedSchema"]
): readonly ElicitationFieldSummary[] => {
  const required = new Set(requestedSchema.required);
  return Object.entries(requestedSchema.properties).map(([name, property]) => {
    const options = fieldOptionsOf(property);
    const description =
      "description" in property && typeof property.description === "string"
        ? property.description
        : undefined;
    const defaultValue =
      "default" in property ? elicitationDefault(property.default) : undefined;
    return {
      name,
      ...(options === undefined ? {} : { options }),
      ...(description === undefined ? {} : { description }),
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
      required: required.has(name),
      type: fieldTypeOf(property),
    };
  });
};

/**
 * Project an `elicitation/create` form request into the S2 register input,
 * carrying a journal-safe field summary (name/type/required/enum choices) and the
 * accept-content validator derived from `requestedSchema`. A non-form mode
 * yields `unsupported-mode` so the bridge answers JSON-RPC Invalid params
 * rather than coercing an unadvertised mode into a text form (RFC 0003, "URL
 * elicitation"). Request-scoped forms are also rejected until the coordinator
 * owns a routable request identity; inventing a pseudo-session would publish a
 * response address that no selected-adapter session can resolve.
 */
export const projectElicitation = (
  request: ElicitationRequest
): ProjectedElicitation => {
  const { params } = request;
  if (!isFormParams(params)) {
    return { type: "unsupported-mode" };
  }
  if (!("sessionId" in params)) {
    return { type: "unsupported-scope" };
  }
  const fields = summarizeFields(params.requestedSchema);
  const validateAccepted = buildAcceptValidator(params.requestedSchema);
  return {
    input: {
      fields,
      kind: "elicitation",
      message: params.message,
      sessionId: SessionId.make(params.sessionId),
      toolCallId: params.toolCallId ?? undefined,
      validateAccepted,
    },
    type: "register",
  };
};
