import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Option, Schema } from "effect";

const MCP_CONFIG_FILENAME = "mcp.json";
// Decode the project `mcp.json` boundary once with a schema. A valid file has
// an `mcpServers` object, while Claude validates each server itself.
const McpConfigShape = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeMcpConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(McpConfigShape)
);

// Ignore malformed or unreadable configuration so it cannot fail every turn.
export const resolveMcpConfigPath = async (
  cwd?: string
): Promise<string | undefined> => {
  if (cwd === undefined) {
    return undefined;
  }
  const path = join(cwd, MCP_CONFIG_FILENAME);
  try {
    const raw = await readFile(path, "utf-8");
    return Option.isSome(decodeMcpConfig(raw)) ? path : undefined;
  } catch {
    return undefined;
  }
};
