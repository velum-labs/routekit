import type {
  EndpointAuthenticator,
  EndpointContext,
  EndpointJsonWriter,
  EndpointObserver
} from "./endpoint-module.js";
import { GatewayEndpoint } from "./endpoint-module.js";

export type UsageOperation = "usage";

type UsageResult = Readonly<{ context: EndpointContext; status: number; body: unknown }>;

export class UsageEndpoint extends GatewayEndpoint<
  UsageOperation,
  EndpointContext,
  EndpointContext,
  UsageResult,
  UsageResult
> {
  constructor(
    authenticate: EndpointAuthenticator,
    usage: (() => unknown | Promise<unknown>) | undefined,
    writeJson: EndpointJsonWriter,
    observe?: EndpointObserver
  ) {
    super(
      "usage",
      authenticate,
      {
        decode: (context) => context,
        resolve: (context) => context,
        execute: async (context) => {
          const value = usage === undefined ? undefined : await usage();
          return {
            context,
            status: value === undefined ? 404 : 200,
            body:
              value ?? {
                error: {
                  message: "provider usage is not configured",
                  type: "not_found"
                }
              }
          };
        },
        observe: (result) => result,
        encode: (result) => {
          writeJson(result.context.response, result.status, result.body);
        }
      },
      observe
    );
  }

  matches(method: string, path: string): boolean {
    return method === "GET" && path === "/usage";
  }

  protected decodeOperation(_context: EndpointContext): UsageOperation {
    return "usage";
  }

}
