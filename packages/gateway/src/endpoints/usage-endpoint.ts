import type {
  EndpointAuthenticator,
  EndpointContext,
  EndpointObserver
} from "./endpoint-module.js";
import { GatewayEndpoint } from "./endpoint-module.js";

export type UsageOperation = "usage";

type UsageResult = Readonly<{ context: EndpointContext; status: number; body: unknown }>;

export class UsageEndpoint extends GatewayEndpoint<UsageOperation> {
  constructor(
    authenticate: EndpointAuthenticator,
    usage: (() => unknown | Promise<unknown>) | undefined,
    observe?: EndpointObserver
  ) {
    super(
      "usage",
      authenticate,
      async (context) => {
        const value = usage === undefined ? undefined : await usage();
        const result: UsageResult = {
          context,
          status: value === undefined ? 404 : 200,
          body: value ?? {
            error: {
              message: "provider usage is not configured",
              type: "not_found"
            }
          }
        };
        result.context.transport.writeJson(result.status, result.body);
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
