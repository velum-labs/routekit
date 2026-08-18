import type { Schema } from "effect";

import {
  authenticationRequestSchemas,
  authenticationResultSchemas,
} from "./methods/authentication.ts";
import {
  filesystemRequestSchemas,
  filesystemResultSchemas,
} from "./methods/filesystem.ts";
import {
  initializeRequestSchemas,
  initializeResultSchemas,
} from "./methods/initialize.ts";
import { protocolNotificationSchemas } from "./methods/notifications.ts";
import {
  permissionRequestSchemas,
  permissionResultSchemas,
} from "./methods/permission.ts";
import {
  sessionNotificationSchemas,
  sessionRequestSchemas,
  sessionResultSchemas,
} from "./methods/session.ts";
import {
  terminalRequestSchemas,
  terminalResultSchemas,
} from "./methods/terminal.ts";

const ACP_STABLE_SCHEMA_TAG = "schema-v1.19.0";
const ACP_STABLE_SCHEMA_COMMIT = "a213df5240048f96d2b23f644984bb20c188a234";
const ACP_STABLE_SCHEMA_SHA256 =
  "92c1dfcda10dd47e99127500a3763da2b471f9ac61e12b9bf0430c32cf953796";
const ACP_STABLE_SCHEMA_SOURCE = `https://github.com/agentclientprotocol/agent-client-protocol/blob/${ACP_STABLE_SCHEMA_COMMIT}/schema/v1/schema.json`;

const CLIENT_TO_AGENT_REQUEST_SCHEMAS = {
  ...authenticationRequestSchemas,
  ...initializeRequestSchemas,
  ...sessionRequestSchemas,
} as const;
const CLIENT_TO_AGENT_RESULT_SCHEMAS = {
  ...authenticationResultSchemas,
  ...initializeResultSchemas,
  ...sessionResultSchemas,
} as const satisfies Record<
  keyof typeof CLIENT_TO_AGENT_REQUEST_SCHEMAS,
  Schema.Top
>;
const AGENT_TO_CLIENT_REQUEST_SCHEMAS = {
  ...filesystemRequestSchemas,
  ...permissionRequestSchemas,
  ...terminalRequestSchemas,
} as const;
const AGENT_TO_CLIENT_RESULT_SCHEMAS = {
  ...filesystemResultSchemas,
  ...permissionResultSchemas,
  ...terminalResultSchemas,
} as const satisfies Record<
  keyof typeof AGENT_TO_CLIENT_REQUEST_SCHEMAS,
  Schema.Top
>;
const CLIENT_NOTIFICATION_SCHEMAS = {
  "session/cancel": sessionNotificationSchemas["session/cancel"],
} as const;
const AGENT_NOTIFICATION_SCHEMAS = {
  "session/update": sessionNotificationSchemas["session/update"],
} as const;
const PROTOCOL_NOTIFICATION_SCHEMAS = protocolNotificationSchemas;

export {
  ACP_STABLE_SCHEMA_COMMIT,
  ACP_STABLE_SCHEMA_SHA256,
  ACP_STABLE_SCHEMA_SOURCE,
  ACP_STABLE_SCHEMA_TAG,
  AGENT_NOTIFICATION_SCHEMAS,
  AGENT_TO_CLIENT_REQUEST_SCHEMAS,
  AGENT_TO_CLIENT_RESULT_SCHEMAS,
  CLIENT_NOTIFICATION_SCHEMAS,
  CLIENT_TO_AGENT_REQUEST_SCHEMAS,
  CLIENT_TO_AGENT_RESULT_SCHEMAS,
  PROTOCOL_NOTIFICATION_SCHEMAS,
};
