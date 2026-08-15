import { Schema } from "effect";

import { AcpToolCallUpdate } from "../session-update.ts";

import { AcpSessionId, withMeta } from "./common.ts";

const AcpPermissionOptionKind = Schema.Literals([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
const AcpPermissionOption = withMeta({
  kind: AcpPermissionOptionKind,
  name: Schema.String,
  optionId: Schema.String,
});
const AcpRequestPermissionOutcome = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("cancelled") }),
  withMeta({
    optionId: Schema.String,
    outcome: Schema.Literal("selected"),
  }),
]).pipe(Schema.toTaggedUnion("outcome"));

const RequestPermissionRequest = withMeta({
  options: Schema.Array(AcpPermissionOption),
  sessionId: AcpSessionId,
  toolCall: AcpToolCallUpdate,
});
const RequestPermissionResult = withMeta({
  outcome: AcpRequestPermissionOutcome,
});

const permissionRequestSchemas = {
  "session/request_permission": RequestPermissionRequest,
} as const;
const permissionResultSchemas = {
  "session/request_permission": RequestPermissionResult,
} as const satisfies Record<keyof typeof permissionRequestSchemas, Schema.Top>;

export { permissionRequestSchemas, permissionResultSchemas };
