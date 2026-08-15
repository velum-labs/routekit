export interface GatewayAuthSource {
  readonly kind: "project" | "environment" | "global" | "workspace";
  readonly location: string;
}

// Gateway PKCE OAuth endpoints used by `routekit-eval login`. The flow needs no client
// registration: send the user to the auth URL, then exchange the returned code.
export const GATEWAY_AUTH_URL = "http://127.0.0.1:8080/auth";
export const GATEWAY_KEYS_EXCHANGE_URL =
  "http://127.0.0.1:8080/v1/auth/keys";

// RFC 0007: these five attribution/key-env constants now live at the author
// tier (`@routekit-eval-contracts/author/gateway-auth`) so builtins can reach them
// through the public `routekit-eval` SDK surface. Re-exported here so this module's other
// (host-only OAuth/login) consumers keep importing the full surface unchanged.
export {
  ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
  ROUTEKIT_EVAL_BEARER_TOKEN_MISSING_MESSAGE,
  ROUTEKIT_EVAL_APP_HTTP_REFERER,
  ROUTEKIT_EVAL_APP_TITLE,
  ROUTEKIT_EVAL_GATEWAY_ATTRIBUTION_HEADERS,
} from "../../author/src/gateway-auth.ts";

export const ROUTEKIT_EVAL_FORCE_BEARER_TOKEN_ENV = "ROUTEKIT_EVAL_FORCE_BEARER_TOKEN";
