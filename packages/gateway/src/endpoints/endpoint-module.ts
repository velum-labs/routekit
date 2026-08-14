import type { IncomingHttpHeaders } from "node:http";
import type { RequestAttribution } from "@velum-labs/routekit-contracts";
import type { Context } from "effect";
import type { HttpClient } from "effect/unstable/http";

import type { BackendRequest, BackendRequestOptions } from "../backend.js";
import type { GatewayDialect } from "../provenance.js";

export type EndpointContext = Readonly<{
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  transport: EndpointTransport;
  platform?: Context.Context<HttpClient.HttpClient>;
}>;

export function withEndpointPlatform(
  context: EndpointContext,
  options: BackendRequestOptions
): BackendRequestOptions {
  return context.platform === undefined ? options : { ...options, platform: context.platform };
}

export type EndpointTransport = Readonly<{
  readJson(): Promise<unknown | undefined>;
  writeJson(status: number, value: unknown): void;
  setHeader(name: string, value: string): void;
  pipe(upstream: Response): Promise<void>;
  dispatch(call: EndpointModelCall): Promise<void>;
}>;

export type EndpointAuthenticator = (context: EndpointContext) => void | Promise<void>;
export type EndpointObserver = (
  endpoint: string,
  operation: string,
  context: EndpointContext
) => void | Promise<void>;

export class EndpointAuthenticationError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "EndpointAuthenticationError";
  }
}

export type EndpointModelCall = Readonly<{
  dialect: GatewayDialect;
  body: unknown;
  defaultModel: string | undefined;
  attribution?: Partial<RequestAttribution>;
  invoke: (
    callId: string,
    signal: AbortSignal,
    onAttribution: NonNullable<BackendRequestOptions["onAttribution"]>
  ) => BackendRequest;
}>;

/**
 * Base for concrete endpoint modules. Node HTTP is adapted once at the server
 * boundary; endpoint logic sees only transport-neutral headers, URL metadata,
 * request decoding, response encoding, upstream piping, and model dispatch.
 */
export abstract class GatewayEndpoint<Operation extends string> {
  constructor(
    readonly name: string,
    private readonly authenticateRequest: EndpointAuthenticator,
    private readonly executeOperation: (
      context: EndpointContext,
      operation: Operation
    ) => void | Promise<void>,
    private readonly observer?: EndpointObserver
  ) {}

  abstract matches(method: string, path: string): boolean;
  protected abstract decodeOperation(context: EndpointContext): Operation;

  async handle(context: EndpointContext): Promise<void> {
    await this.authenticateRequest(context);
    const operation = this.decodeOperation(context);
    await this.executeOperation(context, operation);
    await this.observer?.(this.name, operation, context);
  }
}
