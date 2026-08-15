import { Schema, SchemaGetter } from "effect";

import {
  AcpEnvelopeKind,
  AcpPeer as AcpPeerValues,
  AcpRequestDirection as AcpRequestDirectionValues,
} from "./message-kinds.ts";
import {
  CompleteElicitationParams,
  CreateElicitationParams,
  CreateElicitationResult,
} from "./methods/elicitation.ts";
import { AcpRequestId } from "./primitives.ts";
import {
  ACP_STABLE_SCHEMA_SOURCE,
  ACP_STABLE_SCHEMA_COMMIT,
  ACP_STABLE_SCHEMA_SHA256,
  ACP_STABLE_SCHEMA_TAG,
  AGENT_NOTIFICATION_SCHEMAS,
  AGENT_TO_CLIENT_REQUEST_SCHEMAS,
  AGENT_TO_CLIENT_RESULT_SCHEMAS,
  CLIENT_NOTIFICATION_SCHEMAS,
  CLIENT_TO_AGENT_REQUEST_SCHEMAS,
  CLIENT_TO_AGENT_RESULT_SCHEMAS,
  PROTOCOL_NOTIFICATION_SCHEMAS,
} from "./stable-profile.ts";

const ACP_SCHEMA_VERSION = "v1.19.0";
export const AcpPeer = AcpPeerValues;
export type AcpPeer = (typeof AcpPeer)[keyof typeof AcpPeer];
export const AcpRequestDirection = AcpRequestDirectionValues;
export type AcpRequestDirection =
  (typeof AcpRequestDirection)[keyof typeof AcpRequestDirection];
const ACP_SCHEMA_SOURCE = ACP_STABLE_SCHEMA_SOURCE;
const ACP_PREVIEW_COMMIT = "71f3a052169a23ddfa77f5c4f3120c0f860e33ca";
const ACP_PREVIEW_SCHEMA_SHA256 =
  "33e31bf2a8c0364efaf0f4a480cad4ba11fae52be2778ad32a86a155a6ed9c7b";
const ACP_PREVIEW_SCHEMA_SOURCE = `https://github.com/agentclientprotocol/agent-client-protocol/blob/${ACP_PREVIEW_COMMIT}/schema/v1/schema.unstable.json`;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

const AcpErrorCode = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(INT32_MIN),
  Schema.isLessThanOrEqualTo(INT32_MAX)
).annotate({ identifier: "AcpErrorCode" });
const JsonRpc = Schema.Literal("2.0");
const Forbidden = Schema.optionalKey(Schema.Never);

const RequestEnvelopeFields = {
  error: Forbidden,
  id: AcpRequestId,
  jsonrpc: JsonRpc,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
  result: Forbidden,
} as const;
const NotificationEnvelopeFields = {
  error: Forbidden,
  id: Forbidden,
  jsonrpc: JsonRpc,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
  result: Forbidden,
} as const;
const SuccessResponseEnvelopeFields = {
  error: Forbidden,
  id: AcpRequestId,
  jsonrpc: JsonRpc,
  method: Forbidden,
  result: Schema.Json,
} as const;
const ErrorResponseEnvelopeFields = {
  error: Schema.StructWithRest(
    Schema.Struct({
      code: AcpErrorCode,
      data: Schema.optionalKey(Schema.Json),
      message: Schema.String,
    }),
    [Schema.Record(Schema.String, Schema.Json)]
  ),
  id: AcpRequestId,
  jsonrpc: JsonRpc,
  method: Forbidden,
  result: Forbidden,
} as const;
const EnvelopeRest = [Schema.Record(Schema.String, Schema.Json)] as const;

const AcpRequestEnvelope = Schema.StructWithRest(
  Schema.Struct(RequestEnvelopeFields),
  EnvelopeRest
).annotate({ identifier: "AcpRequestEnvelope" });
const AcpNotificationEnvelope = Schema.StructWithRest(
  Schema.Struct(NotificationEnvelopeFields),
  EnvelopeRest
).annotate({ identifier: "AcpNotificationEnvelope" });
const AcpSuccessResponseEnvelope = Schema.StructWithRest(
  Schema.Struct(SuccessResponseEnvelopeFields),
  EnvelopeRest
).annotate({ identifier: "AcpSuccessResponseEnvelope" });
const AcpErrorResponse = Schema.StructWithRest(
  Schema.Struct(ErrorResponseEnvelopeFields),
  EnvelopeRest
).annotate({ identifier: "AcpErrorResponse" });

const AcpDecodedRequestEnvelope = AcpRequestEnvelope.pipe(
  Schema.decodeTo(
    Schema.StructWithRest(
      Schema.Struct({
        ...RequestEnvelopeFields,
        kind: Schema.Literal(AcpEnvelopeKind.Request),
      }),
      EnvelopeRest
    ),
    {
      decode: SchemaGetter.transform((wire) => ({
        ...wire,
        kind: AcpEnvelopeKind.Request,
      })),
      encode: SchemaGetter.transform(({ kind: _, ...wire }) => wire),
    }
  )
);
const AcpDecodedNotificationEnvelope = AcpNotificationEnvelope.pipe(
  Schema.decodeTo(
    Schema.StructWithRest(
      Schema.Struct({
        ...NotificationEnvelopeFields,
        kind: Schema.Literal(AcpEnvelopeKind.Notification),
      }),
      EnvelopeRest
    ),
    {
      decode: SchemaGetter.transform((wire) => ({
        ...wire,
        kind: AcpEnvelopeKind.Notification,
      })),
      encode: SchemaGetter.transform(({ kind: _, ...wire }) => wire),
    }
  )
);
const AcpDecodedSuccessResponseEnvelope = AcpSuccessResponseEnvelope.pipe(
  Schema.decodeTo(
    Schema.StructWithRest(
      Schema.Struct({
        ...SuccessResponseEnvelopeFields,
        kind: Schema.Literal(AcpEnvelopeKind.SuccessResponse),
      }),
      EnvelopeRest
    ),
    {
      decode: SchemaGetter.transform((wire) => ({
        ...wire,
        kind: AcpEnvelopeKind.SuccessResponse,
      })),
      encode: SchemaGetter.transform(({ kind: _, ...wire }) => wire),
    }
  )
);
const AcpDecodedErrorResponseEnvelope = AcpErrorResponse.pipe(
  Schema.decodeTo(
    Schema.StructWithRest(
      Schema.Struct({
        ...ErrorResponseEnvelopeFields,
        kind: Schema.Literal(AcpEnvelopeKind.ErrorResponse),
      }),
      EnvelopeRest
    ),
    {
      decode: SchemaGetter.transform((wire) => ({
        ...wire,
        kind: AcpEnvelopeKind.ErrorResponse,
      })),
      encode: SchemaGetter.transform(({ kind: _, ...wire }) => wire),
    }
  )
);

const AcpEnvelope = Schema.Union([
  AcpRequestEnvelope,
  AcpNotificationEnvelope,
  AcpSuccessResponseEnvelope,
  AcpErrorResponse,
]).annotate({ identifier: "AcpEnvelope" });
const AcpDecodedEnvelope = Schema.Union([
  AcpDecodedRequestEnvelope,
  AcpDecodedNotificationEnvelope,
  AcpDecodedSuccessResponseEnvelope,
  AcpDecodedErrorResponseEnvelope,
]).annotate({ identifier: "AcpDecodedEnvelope" });

const CLIENT_REQUEST_SCHEMAS = CLIENT_TO_AGENT_REQUEST_SCHEMAS;
const CLIENT_RESULT_SCHEMAS = CLIENT_TO_AGENT_RESULT_SCHEMAS;
const AGENT_REQUEST_SCHEMAS = {
  ...AGENT_TO_CLIENT_REQUEST_SCHEMAS,
  "elicitation/create": CreateElicitationParams,
} as const;
const AGENT_RESULT_SCHEMAS = {
  ...AGENT_TO_CLIENT_RESULT_SCHEMAS,
  "elicitation/create": CreateElicitationResult,
} as const satisfies Record<keyof typeof AGENT_REQUEST_SCHEMAS, Schema.Top>;
const CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS = {
  ...CLIENT_NOTIFICATION_SCHEMAS,
  ...PROTOCOL_NOTIFICATION_SCHEMAS,
} as const;
const AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS = {
  ...AGENT_NOTIFICATION_SCHEMAS,
  ...PROTOCOL_NOTIFICATION_SCHEMAS,
  "elicitation/complete": CompleteElicitationParams,
} as const;

type JsonRest = readonly [Schema.$Record<Schema.String, typeof Schema.Json>];
const knownRequest = <M extends string, P extends Schema.Constraint>(
  method: M,
  params: P
): Schema.StructWithRest<
  Schema.Struct<{
    id: typeof AcpRequestId;
    jsonrpc: typeof JsonRpc;
    method: Schema.Literal<M>;
    params: P;
  }>,
  JsonRest
> =>
  Schema.StructWithRest(
    Schema.Struct({
      id: AcpRequestId,
      jsonrpc: JsonRpc,
      method: Schema.Literal(method),
      params,
    }),
    [Schema.Record(Schema.String, Schema.Json)]
  );
const knownNotification = <M extends string, P extends Schema.Constraint>(
  method: M,
  params: P
): Schema.StructWithRest<
  Schema.Struct<{
    jsonrpc: typeof JsonRpc;
    method: Schema.Literal<M>;
    params: P;
  }>,
  JsonRest
> =>
  Schema.StructWithRest(
    Schema.Struct({
      jsonrpc: JsonRpc,
      method: Schema.Literal(method),
      params,
    }),
    [Schema.Record(Schema.String, Schema.Json)]
  );
const correlatedResult = <M extends string, R extends Schema.Constraint>(
  method: M,
  result: R
): Schema.Struct<{
  method: Schema.Literal<M>;
  result: R;
}> =>
  Schema.Struct({
    method: Schema.Literal(method),
    result,
  });

const AcpClientKnownRequest = Schema.Union([
  knownRequest("authenticate", CLIENT_REQUEST_SCHEMAS.authenticate),
  knownRequest("initialize", CLIENT_REQUEST_SCHEMAS.initialize),
  knownRequest("logout", CLIENT_REQUEST_SCHEMAS.logout),
  knownRequest("session/close", CLIENT_REQUEST_SCHEMAS["session/close"]),
  knownRequest("session/delete", CLIENT_REQUEST_SCHEMAS["session/delete"]),
  knownRequest("session/list", CLIENT_REQUEST_SCHEMAS["session/list"]),
  knownRequest("session/load", CLIENT_REQUEST_SCHEMAS["session/load"]),
  knownRequest("session/new", CLIENT_REQUEST_SCHEMAS["session/new"]),
  knownRequest("session/prompt", CLIENT_REQUEST_SCHEMAS["session/prompt"]),
  knownRequest("session/resume", CLIENT_REQUEST_SCHEMAS["session/resume"]),
  knownRequest(
    "session/set_config_option",
    CLIENT_REQUEST_SCHEMAS["session/set_config_option"]
  ),
  knownRequest("session/set_mode", CLIENT_REQUEST_SCHEMAS["session/set_mode"]),
]).annotate({ identifier: "AcpClientKnownRequest" });
const AcpAgentKnownRequest = Schema.Union([
  knownRequest(
    "elicitation/create",
    AGENT_REQUEST_SCHEMAS["elicitation/create"]
  ),
  knownRequest("fs/read_text_file", AGENT_REQUEST_SCHEMAS["fs/read_text_file"]),
  knownRequest(
    "fs/write_text_file",
    AGENT_REQUEST_SCHEMAS["fs/write_text_file"]
  ),
  knownRequest(
    "session/request_permission",
    AGENT_REQUEST_SCHEMAS["session/request_permission"]
  ),
  knownRequest("terminal/create", AGENT_REQUEST_SCHEMAS["terminal/create"]),
  knownRequest("terminal/kill", AGENT_REQUEST_SCHEMAS["terminal/kill"]),
  knownRequest("terminal/output", AGENT_REQUEST_SCHEMAS["terminal/output"]),
  knownRequest("terminal/release", AGENT_REQUEST_SCHEMAS["terminal/release"]),
  knownRequest(
    "terminal/wait_for_exit",
    AGENT_REQUEST_SCHEMAS["terminal/wait_for_exit"]
  ),
]).annotate({ identifier: "AcpAgentKnownRequest" });
const AcpClientKnownNotification = Schema.Union([
  knownNotification(
    "$/cancel_request",
    CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS["$/cancel_request"]
  ),
  knownNotification(
    "session/cancel",
    CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS["session/cancel"]
  ),
]).annotate({ identifier: "AcpClientKnownNotification" });
const AcpAgentKnownNotification = Schema.Union([
  knownNotification(
    "$/cancel_request",
    AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS["$/cancel_request"]
  ),
  knownNotification(
    "elicitation/complete",
    AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS["elicitation/complete"]
  ),
  knownNotification(
    "session/update",
    AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS["session/update"]
  ),
]).annotate({ identifier: "AcpAgentKnownNotification" });
const AcpClientCorrelatedResult = Schema.Union([
  correlatedResult("authenticate", CLIENT_RESULT_SCHEMAS.authenticate),
  correlatedResult("initialize", CLIENT_RESULT_SCHEMAS.initialize),
  correlatedResult("logout", CLIENT_RESULT_SCHEMAS.logout),
  correlatedResult("session/close", CLIENT_RESULT_SCHEMAS["session/close"]),
  correlatedResult("session/delete", CLIENT_RESULT_SCHEMAS["session/delete"]),
  correlatedResult("session/list", CLIENT_RESULT_SCHEMAS["session/list"]),
  correlatedResult("session/load", CLIENT_RESULT_SCHEMAS["session/load"]),
  correlatedResult("session/new", CLIENT_RESULT_SCHEMAS["session/new"]),
  correlatedResult("session/prompt", CLIENT_RESULT_SCHEMAS["session/prompt"]),
  correlatedResult("session/resume", CLIENT_RESULT_SCHEMAS["session/resume"]),
  correlatedResult(
    "session/set_config_option",
    CLIENT_RESULT_SCHEMAS["session/set_config_option"]
  ),
  correlatedResult(
    "session/set_mode",
    CLIENT_RESULT_SCHEMAS["session/set_mode"]
  ),
]).annotate({ identifier: "AcpClientCorrelatedResult" });
const AcpAgentCorrelatedResult = Schema.Union([
  correlatedResult(
    "elicitation/create",
    AGENT_RESULT_SCHEMAS["elicitation/create"]
  ),
  correlatedResult(
    "fs/read_text_file",
    AGENT_RESULT_SCHEMAS["fs/read_text_file"]
  ),
  correlatedResult(
    "fs/write_text_file",
    AGENT_RESULT_SCHEMAS["fs/write_text_file"]
  ),
  correlatedResult(
    "session/request_permission",
    AGENT_RESULT_SCHEMAS["session/request_permission"]
  ),
  correlatedResult("terminal/create", AGENT_RESULT_SCHEMAS["terminal/create"]),
  correlatedResult("terminal/kill", AGENT_RESULT_SCHEMAS["terminal/kill"]),
  correlatedResult("terminal/output", AGENT_RESULT_SCHEMAS["terminal/output"]),
  correlatedResult(
    "terminal/release",
    AGENT_RESULT_SCHEMAS["terminal/release"]
  ),
  correlatedResult(
    "terminal/wait_for_exit",
    AGENT_RESULT_SCHEMAS["terminal/wait_for_exit"]
  ),
]).annotate({ identifier: "AcpAgentCorrelatedResult" });

export type AcpRequestEnvelope = typeof AcpRequestEnvelope.Type;
export type AcpNotificationEnvelope = typeof AcpNotificationEnvelope.Type;
export type AcpSuccessResponseEnvelope = typeof AcpSuccessResponseEnvelope.Type;
export type AcpErrorResponse = typeof AcpErrorResponse.Type;
export type AcpEnvelope = typeof AcpEnvelope.Type;
export type AcpDecodedEnvelope = typeof AcpDecodedEnvelope.Type;
export type AcpRequestId = typeof AcpRequestId.Type;
export type AcpClientKnownRequest = typeof AcpClientKnownRequest.Type;
export type AcpAgentKnownRequest = typeof AcpAgentKnownRequest.Type;
export type AcpClientKnownNotification = typeof AcpClientKnownNotification.Type;
export type AcpAgentKnownNotification = typeof AcpAgentKnownNotification.Type;
export type AcpClientCorrelatedResult = typeof AcpClientCorrelatedResult.Type;
export type AcpAgentCorrelatedResult = typeof AcpAgentCorrelatedResult.Type;

export {
  ACP_PREVIEW_COMMIT,
  ACP_PREVIEW_SCHEMA_SOURCE,
  ACP_PREVIEW_SCHEMA_SHA256,
  ACP_SCHEMA_SOURCE,
  ACP_SCHEMA_VERSION,
  ACP_STABLE_SCHEMA_TAG,
  ACP_STABLE_SCHEMA_COMMIT,
  ACP_STABLE_SCHEMA_SHA256,
  AGENT_REQUEST_SCHEMAS,
  AGENT_RESULT_SCHEMAS,
  AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS,
  AcpAgentCorrelatedResult,
  AcpAgentKnownNotification,
  AcpAgentKnownRequest,
  AcpDecodedEnvelope,
  AcpEnvelope,
  AcpErrorResponse,
  AcpNotificationEnvelope,
  AcpRequestEnvelope,
  AcpRequestId,
  AcpSuccessResponseEnvelope,
  AcpClientCorrelatedResult,
  AcpClientKnownNotification,
  AcpClientKnownRequest,
  CLIENT_REQUEST_SCHEMAS,
  CLIENT_RESULT_SCHEMAS,
  CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS,
};
