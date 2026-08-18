import { Schema } from "effect";

import { AcpContentBlock } from "../content.ts";
import {
  AcpOptionalNullable,
  AcpOptionalTolerantArray,
  AcpTolerantArray,
} from "../primitives.ts";
import { AcpSessionConfigOption } from "../session-config.ts";
import { AcpSessionUpdate } from "../session-update.ts";

import { AcpSessionId, emptyResult, withMeta } from "./common.ts";
import { AcpMcpServer } from "./mcp.ts";

const AcpSessionMode = withMeta({
  description: AcpOptionalNullable(Schema.String),
  id: Schema.String,
  name: Schema.String,
});
const AcpSessionModeState = withMeta({
  availableModes: AcpTolerantArray(AcpSessionMode),
  currentModeId: Schema.String,
});
const AcpSessionInfo = withMeta({
  additionalDirectories: AcpTolerantArray(Schema.String),
  cwd: Schema.String,
  sessionId: AcpSessionId,
  title: AcpOptionalNullable(Schema.String),
  updatedAt: AcpOptionalNullable(Schema.String),
});
const sessionSetupFields = {
  additionalDirectories: AcpTolerantArray(Schema.String),
  cwd: Schema.String,
  mcpServers: AcpTolerantArray(AcpMcpServer),
} as const;
const sessionStateFields = {
  configOptions: AcpOptionalTolerantArray(AcpSessionConfigOption),
  modes: AcpOptionalNullable(AcpSessionModeState),
} as const;

const NewSessionRequest = withMeta(sessionSetupFields);
const NewSessionResult = withMeta({
  ...sessionStateFields,
  sessionId: AcpSessionId,
});
const LoadSessionRequest = withMeta({
  ...sessionSetupFields,
  sessionId: AcpSessionId,
});
const LoadSessionResult = withMeta(sessionStateFields);
const ListSessionsRequest = withMeta({
  cursor: AcpOptionalNullable(Schema.String),
  cwd: AcpOptionalNullable(Schema.String),
});
const ListSessionsResult = withMeta({
  nextCursor: AcpOptionalNullable(Schema.String),
  sessions: AcpTolerantArray(AcpSessionInfo),
});
const DeleteSessionRequest = withMeta({ sessionId: AcpSessionId });
const DeleteSessionResult = emptyResult();
const ResumeSessionRequest = withMeta({
  ...sessionSetupFields,
  sessionId: AcpSessionId,
});
const ResumeSessionResult = withMeta(sessionStateFields);
const CloseSessionRequest = withMeta({ sessionId: AcpSessionId });
const CloseSessionResult = emptyResult();
const SetSessionModeRequest = withMeta({
  modeId: Schema.String,
  sessionId: AcpSessionId,
});
const SetSessionModeResult = emptyResult();
const setSessionConfigOptionFields = {
  configId: Schema.String,
  sessionId: AcpSessionId,
} as const;
const SetSessionConfigOptionRequest = Schema.Union([
  withMeta({
    ...setSessionConfigOptionFields,
    type: Schema.Literal("boolean"),
    value: Schema.Boolean,
  }),
  withMeta({
    ...setSessionConfigOptionFields,
    value: Schema.String,
  }),
]);
const SetSessionConfigOptionResult = withMeta({
  configOptions: AcpTolerantArray(AcpSessionConfigOption),
});
const PromptRequest = withMeta({
  prompt: Schema.Array(AcpContentBlock),
  sessionId: AcpSessionId,
});
const PromptResult = withMeta({
  stopReason: Schema.Literals([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ]),
});

const SessionCancelNotification = withMeta({ sessionId: AcpSessionId });
const SessionUpdateNotification = withMeta({
  sessionId: AcpSessionId,
  update: AcpSessionUpdate,
});

const sessionRequestSchemas = {
  "session/close": CloseSessionRequest,
  "session/delete": DeleteSessionRequest,
  "session/list": ListSessionsRequest,
  "session/load": LoadSessionRequest,
  "session/new": NewSessionRequest,
  "session/prompt": PromptRequest,
  "session/resume": ResumeSessionRequest,
  "session/set_config_option": SetSessionConfigOptionRequest,
  "session/set_mode": SetSessionModeRequest,
} as const;
const sessionResultSchemas = {
  "session/close": CloseSessionResult,
  "session/delete": DeleteSessionResult,
  "session/list": ListSessionsResult,
  "session/load": LoadSessionResult,
  "session/new": NewSessionResult,
  "session/prompt": PromptResult,
  "session/resume": ResumeSessionResult,
  "session/set_config_option": SetSessionConfigOptionResult,
  "session/set_mode": SetSessionModeResult,
} as const satisfies Record<keyof typeof sessionRequestSchemas, Schema.Top>;
const sessionNotificationSchemas = {
  "session/cancel": SessionCancelNotification,
  "session/update": SessionUpdateNotification,
} as const;

export {
  sessionNotificationSchemas,
  sessionRequestSchemas,
  sessionResultSchemas,
};
