import type { IncomingHttpHeaders } from "node:http";
import type { RequestAttribution } from "@velum-labs/routekit-contracts";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { type Context, Effect } from "effect";

import type { BackendRequest, BackendRequestOptions } from "../providers/backend.js";
import { gatewayTry } from "../effect/gateway.js";
import type { GatewayDialect } from "../observability/provenance.js";

export type EndpointContext = Readonly<{
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  transport: EndpointTransport;
  platform?: Context.Context<RouteKitPlatform>;
}>;

export function withEndpointPlatform(
  context: EndpointContext,
  options: BackendRequestOptions
): BackendRequestOptions {
  return context.platform === undefined ? options : { ...options, platform: context.platform };
}

export type EndpointTransport = Readonly<{
  readJson(): Effect.Effect<unknown | undefined, Error>;
  writeJson(status: number, value: unknown): void;
  setHeader(name: string, value: string): void;
  pipe(upstream: Response): void;
  dispatch(call: EndpointModelCall): void;
}>;

export type EndpointAuthenticator = (context: EndpointContext) => void;
export type EndpointObserver = (
  endpoint: string,
  operation: string,
  context: EndpointContext
) => void;

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

export type EndpointProgram = Effect.Effect<void, Error, RouteKitPlatform>;

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
    ) => EndpointProgram,
    private readonly observer?: EndpointObserver
  ) {}

  abstract matches(method: string, path: string): boolean;
  protected abstract decodeOperation(context: EndpointContext): Operation;

  handle(context: EndpointContext): EndpointProgram {
    const self = this;
    return gatewayTry(() => {
      self.authenticateRequest(context);
      return self.decodeOperation(context);
    }).pipe(
      Effect.flatMap((operation) =>
        self.executeOperation(context, operation).pipe(
          Effect.flatMap(() => {
            const observer = self.observer;
            return observer === undefined
              ? Effect.void
              : gatewayTry(() => observer(self.name, operation, context));
          })
        )
      )
    );
  }
}
