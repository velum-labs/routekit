// The author-facing MCP surface. A feature handler that needs to call an
// external MCP server declared in the workspace `mcp.json` receives an
// `McpResolver` on its context (beside `stores` and `use`); `mcp(name)`
// resolves the named server to a connected {@link McpClient}. Like the other
// author handles this is plain-Promise and effect-free: the host does the
// Effect/`@modelcontextprotocol/sdk` bridging on its side (RFC 0002).

/** One content block returned by a tool call, projected to text/image. */
export type McpContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

/** The result of a single {@link McpClient.callTool}. */
export interface McpCallResult {
  readonly content: readonly McpContentBlock[];
  /** True when the server reported the call itself failed. */
  readonly isError: boolean;
}

/** One tool a server advertises via {@link McpClient.listTools}. */
export interface McpToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
  /** The tool's JSON-Schema input contract, as the server declared it. */
  readonly inputSchema?: unknown;
}

/**
 * A connected client for one MCP server, resolved from the workspace `mcp.json`
 * by the `mcp(name)` handle. Plain Promises, no Effect. The host owns the
 * connection lifecycle for the run, so a handler never needs to `close()` it;
 * the method is exposed only for a handler that wants to release a server early.
 */
export interface McpClient {
  /** List the tools this server advertises. */
  readonly listTools: () => Promise<{ readonly tools: readonly McpToolInfo[] }>;
  /** Call one tool by name with JSON arguments. */
  readonly callTool: (request: {
    readonly name: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }) => Promise<McpCallResult>;
  /** Release this server's connection early (optional; the host closes it at run end). */
  readonly close?: (() => Promise<void>) | undefined;
}

/**
 * Handle for reaching MCP servers declared in the workspace `mcp.json`. Call
 * `mcp(name)` with a declared server name to get a connected {@link McpClient}.
 * Rejects when the name is not in `mcp.json` or the server cannot be reached.
 */
export type McpResolver = (name: string) => Promise<McpClient>;
