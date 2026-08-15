import { Schema } from "effect";

import type { WithMeta } from "./common.ts";

import { withMeta } from "./common.ts";

const AcpEnvVariable = withMeta({
  name: Schema.String,
  value: Schema.String,
});
const AcpHttpHeader = withMeta({
  name: Schema.String,
  value: Schema.String,
});
const AcpMcpServerStdio = withMeta({
  args: Schema.Array(Schema.String),
  command: Schema.String,
  env: Schema.Array(AcpEnvVariable),
  name: Schema.String,
});

const remoteMcpServer = <T extends "http" | "sse">(
  type: T
): WithMeta<{
  headers: Schema.$Array<typeof AcpHttpHeader>;
  name: typeof Schema.String;
  type: Schema.Literal<T>;
  url: typeof Schema.String;
}> =>
  withMeta({
    headers: Schema.Array(AcpHttpHeader),
    name: Schema.String,
    type: Schema.Literal(type),
    url: Schema.String,
  });

const AcpMcpServer = Schema.Union([
  remoteMcpServer("http"),
  remoteMcpServer("sse"),
  AcpMcpServerStdio,
]);

export { AcpEnvVariable, AcpMcpServer };
