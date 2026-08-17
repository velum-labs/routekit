import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import type {
  EndpointAuthenticator,
  EndpointContext,
  EndpointObserver
} from "./endpoint-module.js";
import { GatewayEndpoint } from "./endpoint-module.js";

export type UsageOperation = "usage";

export class UsageEndpoint extends GatewayEndpoint<UsageOperation> {
  constructor(
    authenticate: EndpointAuthenticator,
    usage: (() => Effect.Effect<unknown, Error, RouteKitPlatform>) | undefined,
    observe?: EndpointObserver
  ) {
    super(
      "usage",
      authenticate,
      (context) =>
        Effect.gen(function* () {
          const value = usage === undefined ? undefined : yield* usage();
          context.transport.writeJson(
            value === undefined ? 404 : 200,
            value ?? {
              error: {
                message: "provider usage is not configured",
                type: "not_found"
              }
            }
          );
        }),
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
