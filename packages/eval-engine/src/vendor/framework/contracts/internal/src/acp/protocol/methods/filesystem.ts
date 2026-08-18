import { Schema } from "effect";

import {
  AcpOptionalNullable,
  AcpUint32,
} from "../primitives.ts";

import { AcpSessionId, emptyResult, withMeta } from "./common.ts";

const WriteTextFileRequest = withMeta({
  content: Schema.String,
  path: Schema.String,
  sessionId: AcpSessionId,
});
const WriteTextFileResult = emptyResult();
const ReadTextFileRequest = withMeta({
  limit: AcpOptionalNullable(AcpUint32),
  line: AcpOptionalNullable(AcpUint32),
  path: Schema.String,
  sessionId: AcpSessionId,
});
const ReadTextFileResult = withMeta({ content: Schema.String });

const filesystemRequestSchemas = {
  "fs/read_text_file": ReadTextFileRequest,
  "fs/write_text_file": WriteTextFileRequest,
} as const;
const filesystemResultSchemas = {
  "fs/read_text_file": ReadTextFileResult,
  "fs/write_text_file": WriteTextFileResult,
} as const satisfies Record<keyof typeof filesystemRequestSchemas, Schema.Top>;

export { filesystemRequestSchemas, filesystemResultSchemas };
