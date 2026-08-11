import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAttribution } from "@velum-labs/routekit-contracts";

import type { BackendRequestOptions } from "../backend.js";
import { runEndpointPipeline } from "../endpoint-pipeline.js";
import type { GatewayDialect } from "../provenance.js";

export type EndpointContext = Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  url: URL;
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

export type EndpointStages<Operation extends string, Decoded, Resolved, Executed, Observed> =
  Readonly<{
    decode(context: EndpointContext, operation: Operation): Decoded | Promise<Decoded>;
    resolve(decoded: Decoded, operation: Operation): Resolved | Promise<Resolved>;
    execute(resolved: Resolved, operation: Operation): Executed | Promise<Executed>;
    observe(executed: Executed, operation: Operation): Observed | Promise<Observed>;
    encode(observed: Observed, operation: Operation): void | Promise<void>;
  }>;

export type EndpointModelCall = Readonly<{
  dialect: GatewayDialect;
  body: unknown;
  defaultModel: string | undefined;
  attribution?: Partial<RequestAttribution>;
  invoke: (
    callId: string,
    signal: AbortSignal,
    onAttribution: NonNullable<BackendRequestOptions["onAttribution"]>
  ) => Promise<Response>;
}>;

export type EndpointBodyReader = (context: EndpointContext) => Promise<unknown | undefined>;
export type EndpointJsonWriter = (
  response: ServerResponse,
  status: number,
  value: unknown
) => void;

/**
 * Base for concrete HTTP endpoints. Matching and operation decoding remain in
 * each endpoint module; only the fixed stage sequencing is shared.
 */
export abstract class GatewayEndpoint<
  Operation extends string,
  Decoded,
  Resolved,
  Executed,
  Observed
> {
  constructor(
    readonly name: string,
    private readonly authenticateRequest: EndpointAuthenticator,
    private readonly stages: EndpointStages<Operation, Decoded, Resolved, Executed, Observed>,
    private readonly observer?: EndpointObserver
  ) {}

  abstract matches(method: string, path: string): boolean;
  protected abstract decodeOperation(context: EndpointContext): Operation;

  async handle(context: EndpointContext): Promise<void> {
    const stages = this.stages;
    await runEndpointPipeline(context, {
      authenticate: this.authenticateRequest,
      decode: async (input) => {
        const operation = this.decodeOperation(input);
        return {
          operation,
          decoded: await stages.decode(input, operation)
        };
      },
      resolve: async ({ operation, decoded }) => ({
        operation,
        resolved: await stages.resolve(decoded, operation)
      }),
      execute: async ({ operation, resolved }) => ({
        operation,
        executed: await stages.execute(resolved, operation)
      }),
      observe: async ({ operation, executed }) => {
        await this.observer?.(this.name, operation, context);
        return {
          operation,
          observed: await stages.observe(executed, operation)
        };
      },
      encode: async ({ operation, observed }) => {
        await stages.encode(observed, operation);
      }
    });
  }
}
