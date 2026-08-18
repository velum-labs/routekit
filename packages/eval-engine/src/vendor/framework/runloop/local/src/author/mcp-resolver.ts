import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";

import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Option, Schema } from "effect";

import type {
  McpCallResult,
  McpClient,
  McpContentBlock,
  McpResolver,
} from "../../../../contracts/author/src/mcp.ts";

// The workspace `mcp.json` boundary, decoded once. A feature's `mcp(name)`
// handle resolves a server from here; the same file also feeds the harnesses
// (claude `--mcp-config`, the pi extension), so one declaration drives both the
// agent-facing and feature-facing paths.
const StdioServerSchema = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const HttpServerSchema = Schema.Struct({
  type: Schema.Literal("http"),
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const ServerSchema = Schema.Union([StdioServerSchema, HttpServerSchema]);
const McpConfigSchema = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, ServerSchema),
});
type McpServer = typeof ServerSchema.Type;
type McpConfig = typeof McpConfigSchema.Type;

const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(McpConfigSchema)
);

const ENV_REFERENCE_PATTERN = /\$\{([^}]+)\}/gu;

const expandEnv = (
  value: string,
  env: Readonly<Record<string, string | undefined>>
): string =>
  value.replaceAll(
    ENV_REFERENCE_PATTERN,
    (_match: string, name: string) => env[name] ?? ""
  );

const expandEnvRecord = (
  record: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, expandEnv(value, env)])
  );

const embeddedResourceText = (
  resource: Extract<ContentBlock, { type: "resource" }>["resource"]
): string =>
  "text" in resource
    ? `${resource.uri}\n\n${resource.text}`
    : `[binary resource omitted: ${resource.uri}]`;

// The author surface exposes text/image only, so audio/resource/resource_link
// (valid MCP content that has no author equivalent) is projected to text rather
// than dropped.
const toAuthorContent = (block: ContentBlock): McpContentBlock => {
  switch (block.type) {
    case "text": {
      return {
        type: "text",
        text: block.text,
      };
    }
    case "image": {
      return {
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      };
    }
    case "audio": {
      return {
        type: "text",
        text: `[audio content omitted: ${block.mimeType}]`,
      };
    }
    case "resource": {
      return {
        type: "text",
        text: embeddedResourceText(block.resource),
      };
    }
    case "resource_link": {
      return {
        type: "text",
        text: `[resource: ${block.name} <${block.uri}>]`,
      };
    }
    default: {
      return {
        type: "text",
        text: "[unsupported MCP content]",
      };
    }
  }
};

const isContentArray = (value: unknown): value is CallToolResult["content"] =>
  Array.isArray(value);

const toAuthorResult = (
  raw: Awaited<ReturnType<Client["callTool"]>>
): McpCallResult => {
  const content = isContentArray(raw.content) ? raw.content : [];
  return {
    content: content.map(toAuthorContent),
    isError: raw.isError === true,
  };
};

const makeTransport = (
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>
): Transport => {
  if (server.type === "stdio") {
    const params: StdioServerParameters = { command: server.command };
    if (server.args !== undefined) {
      params.args = [...server.args];
    }
    if (server.env !== undefined) {
      // Merge OVER the SDK's safe inherited env (PATH/HOME/…): setting
      // `params.env` at all makes the SDK skip getDefaultEnvironment(), so
      // without this a local server's launcher loses PATH and cannot spawn.
      params.env = {
        ...getDefaultEnvironment(),
        ...expandEnvRecord(server.env, env),
      };
    }
    return new StdioClientTransport(params);
  }
  const http = new StreamableHTTPClientTransport(
    new URL(server.url),
    server.headers === undefined
      ? undefined
      : { requestInit: { headers: expandEnvRecord(server.headers, env) } }
  );
  // SDK 1.29.0 type bug: StreamableHTTPClientTransport's own `sessionId` getter
  // is `string | undefined`, which its own `Transport` interface (`sessionId?:
  // string`) rejects under exactOptionalPropertyTypes. No cast-free path; the
  // assertion is scoped off for this file in oxlint.config.ts.
  return http as unknown as Transport;
};

// A connected client whose `close` is always present (the SDK provides one), so
// the resolver's eviction wrapper can call it without a possibly-undefined guard.
export type ConnectedClient = McpClient & {
  readonly close: () => Promise<void>;
};

type ConnectFn = (
  name: string,
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>
) => Promise<ConnectedClient>;

const connectClient = async (
  serverName: string,
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>
): Promise<ConnectedClient> => {
  const client = new Client({
    name: `ori-${serverName}`,
    version: "0.1.0",
  });
  await client.connect(makeTransport(server, env));
  return {
    listTools: () => client.listTools(),
    callTool: (request) => client.callTool(request).then(toAuthorResult),
    close: () => client.close(),
  };
};

// A connect that never resolved has nothing to close; swallow it so `close` is
// a clean teardown regardless of per-server connect failures.
const ignoreConnectFailure = (): McpClient | undefined => undefined;

const readConfig = async (path: string): Promise<McpConfig | undefined> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  return decodeConfig(raw).pipe(Option.getOrUndefined);
};

// Read the config and connect as one promise so the caller can claim the cache
// slot synchronously (before any await). An undeclared server throws here,
// inside that promise, so its rejection flows through the same eviction path as
// a failed connect. The returned client's `close` evicts its own cache entry so
// a later `mcp(name)` reconnects and run-end teardown never double-closes.
const openMcpClient = async (
  deps: {
    readonly open: Map<string, Promise<McpClient>>;
    readonly configPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly connect: ConnectFn;
  },
  name: string
): Promise<McpClient> => {
  const config = await readConfig(deps.configPath);
  const server = config?.mcpServers[name];
  if (server === undefined) {
    throw new Error(
      `MCP server "${name}" is not declared in ${deps.configPath}`
    );
  }
  const client = await deps.connect(name, server, deps.env);
  return {
    ...client,
    close: (): Promise<void> => {
      deps.open.delete(name);
      return client.close();
    },
  };
};

/**
 * Build the author-facing `mcp(name)` handle for one run. Servers are declared
 * in the workspace `mcp.json` (resolved from `configPath`); a handler calls
 * `mcp("linear")` to get a connected {@link McpClient}. Connections are cached
 * per name for the run and closed together via the returned `close`.
 *
 * A plain-Promise factory (no `Context`/`runPromiseWith`) because the MCP SDK is
 * itself promise-based — unlike the store resolver, there is no Effect service
 * to run against, so the host bridging is just reading a file and connecting.
 */
export const makeAuthorMcpResolver = (
  input: {
    readonly configPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
  // Test seam: the live path connects a real MCP transport, so a unit test
  // injects a fake here to observe caching without a server.
  connect: ConnectFn = connectClient
): { readonly mcp: McpResolver; readonly close: () => Promise<void> } => {
  const open = new Map<string, Promise<McpClient>>();
  const deps = {
    configPath: input.configPath,
    connect,
    env: input.env,
    open,
  };

  const mcp: McpResolver = async (name) => {
    const existing = open.get(name);
    if (existing !== undefined) {
      return await existing;
    }
    // Claim the slot synchronously, before any await, so two overlapping
    // `mcp(name)` calls share one connection instead of each opening (and
    // leaking) its own. A failure evicts the entry so a later call retries
    // rather than replaying the same rejection for the daemon's life.
    const pending = openMcpClient(deps, name).catch((error: unknown) => {
      open.delete(name);
      throw error;
    });
    open.set(name, pending);
    return await pending;
  };

  const close = async (): Promise<void> => {
    // Snapshot and clear first so a client's own `close` eviction cannot mutate
    // the map mid-iteration, and nothing is closed twice.
    const pending = [...open.values()];
    open.clear();
    const clients = await Promise.all(
      pending.map((p) => p.catch(ignoreConnectFailure))
    );
    await Promise.all(
      clients.map((client) => client?.close?.() ?? Promise.resolve())
    );
  };

  return {
    mcp,
    close,
  };
};

/** Test-only seam: the pure boundary mappers that never touch a live server. */
export const __testing = {
  toAuthorResult,
};
