import { Schema } from "effect";

import {
  AcpDefaulted,
  AcpOptionalNullable,
  AcpUint16,
} from "../primitives.ts";

import { AcpAuthMethods } from "./authentication.ts";
import { withMeta } from "./common.ts";
import { ClientElicitationCapabilityFields } from "./elicitation.ts";

const AcpImplementation = withMeta({
  name: Schema.String,
  title: AcpOptionalNullable(Schema.String),
  version: Schema.String,
});
const AcpEmptyCapability = withMeta({});
const DefaultFalse = AcpDefaulted(Schema.Boolean, false);
const AcpFileSystemCapabilities = withMeta({
  readTextFile: DefaultFalse,
  writeTextFile: DefaultFalse,
});
const AcpBooleanConfigOptionCapabilities = withMeta({});
const AcpClientSessionCapabilities = withMeta({
  configOptions: AcpOptionalNullable(
    withMeta({
      boolean: AcpOptionalNullable(AcpBooleanConfigOptionCapabilities),
    })
  ),
});
const AcpClientCapabilities = withMeta({
  ...ClientElicitationCapabilityFields,
  fs: AcpDefaulted(AcpFileSystemCapabilities, {
    readTextFile: false,
    writeTextFile: false,
  }),
  session: AcpOptionalNullable(AcpClientSessionCapabilities),
  terminal: DefaultFalse,
});
const AcpPromptCapabilities = withMeta({
  audio: DefaultFalse,
  embeddedContext: DefaultFalse,
  image: DefaultFalse,
});
const AcpMcpCapabilities = withMeta({
  http: DefaultFalse,
  sse: DefaultFalse,
});
const AcpSessionCapabilities = withMeta({
  additionalDirectories: AcpOptionalNullable(AcpEmptyCapability),
  close: AcpOptionalNullable(AcpEmptyCapability),
  delete: AcpOptionalNullable(AcpEmptyCapability),
  list: AcpOptionalNullable(AcpEmptyCapability),
  resume: AcpOptionalNullable(AcpEmptyCapability),
});
const AcpAgentAuthCapabilities = withMeta({
  logout: AcpOptionalNullable(AcpEmptyCapability),
});
const AcpAgentCapabilities = withMeta({
  auth: AcpDefaulted(AcpAgentAuthCapabilities, {}),
  loadSession: DefaultFalse,
  mcpCapabilities: AcpDefaulted(AcpMcpCapabilities, {
    http: false,
    sse: false,
  }),
  promptCapabilities: AcpDefaulted(AcpPromptCapabilities, {
    audio: false,
    embeddedContext: false,
    image: false,
  }),
  sessionCapabilities: AcpDefaulted(AcpSessionCapabilities, {}),
});

const InitializeRequest = withMeta({
  clientCapabilities: AcpDefaulted(AcpClientCapabilities, {
    fs: {
      readTextFile: false,
      writeTextFile: false,
    },
    terminal: false,
  }),
  clientInfo: AcpOptionalNullable(AcpImplementation),
  protocolVersion: AcpUint16,
});
const InitializeResult = withMeta({
  agentCapabilities: AcpDefaulted(AcpAgentCapabilities, {
    auth: {},
    loadSession: false,
    mcpCapabilities: {
      http: false,
      sse: false,
    },
    promptCapabilities: {
      audio: false,
      embeddedContext: false,
      image: false,
    },
    sessionCapabilities: {},
  }),
  agentInfo: AcpOptionalNullable(AcpImplementation),
  authMethods: AcpAuthMethods,
  protocolVersion: AcpUint16,
});

const initializeRequestSchemas = { initialize: InitializeRequest } as const;
const initializeResultSchemas = {
  initialize: InitializeResult,
} as const satisfies Record<keyof typeof initializeRequestSchemas, Schema.Top>;

export { initializeRequestSchemas, initializeResultSchemas };
