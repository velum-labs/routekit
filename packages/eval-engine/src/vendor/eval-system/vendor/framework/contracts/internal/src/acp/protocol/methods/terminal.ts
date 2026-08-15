import { Schema } from "effect";

import {
  AcpOptionalNullable,
  AcpTolerantArray,
  AcpUint32,
  AcpUint64,
} from "../primitives.ts";

import { AcpSessionId, emptyResult, withMeta } from "./common.ts";
import { AcpEnvVariable } from "./mcp.ts";

const AcpTerminalExitStatus = withMeta({
  exitCode: AcpOptionalNullable(AcpUint32),
  signal: AcpOptionalNullable(Schema.String),
});
const terminalParams = {
  sessionId: AcpSessionId,
  terminalId: Schema.String,
} as const;

const CreateTerminalRequest = withMeta({
  args: AcpTolerantArray(Schema.String),
  command: Schema.String,
  cwd: AcpOptionalNullable(Schema.String),
  env: AcpTolerantArray(AcpEnvVariable),
  outputByteLimit: AcpOptionalNullable(AcpUint64),
  sessionId: AcpSessionId,
});
const CreateTerminalResult = withMeta({ terminalId: Schema.String });
const TerminalOutputRequest = withMeta(terminalParams);
const TerminalOutputResult = withMeta({
  exitStatus: AcpOptionalNullable(AcpTerminalExitStatus),
  output: Schema.String,
  truncated: Schema.Boolean,
});
const ReleaseTerminalRequest = withMeta(terminalParams);
const ReleaseTerminalResult = emptyResult();
const WaitForTerminalExitRequest = withMeta(terminalParams);
const WaitForTerminalExitResult = withMeta({
  exitCode: AcpOptionalNullable(AcpUint32),
  signal: AcpOptionalNullable(Schema.String),
});
const KillTerminalRequest = withMeta(terminalParams);
const KillTerminalResult = emptyResult();

const terminalRequestSchemas = {
  "terminal/create": CreateTerminalRequest,
  "terminal/kill": KillTerminalRequest,
  "terminal/output": TerminalOutputRequest,
  "terminal/release": ReleaseTerminalRequest,
  "terminal/wait_for_exit": WaitForTerminalExitRequest,
} as const;
const terminalResultSchemas = {
  "terminal/create": CreateTerminalResult,
  "terminal/kill": KillTerminalResult,
  "terminal/output": TerminalOutputResult,
  "terminal/release": ReleaseTerminalResult,
  "terminal/wait_for_exit": WaitForTerminalExitResult,
} as const satisfies Record<keyof typeof terminalRequestSchemas, Schema.Top>;

export { terminalRequestSchemas, terminalResultSchemas };
