export interface OpenRouterAuthSource {
  readonly kind: "project" | "environment" | "global" | "workspace";
  readonly location: string;
}

// OpenRouter PKCE OAuth endpoints used by `ori login`. The flow needs no client
// registration: send the user to the auth URL, then exchange the returned code.
export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEYS_EXCHANGE_URL =
  "https://openrouter.ai/api/v1/auth/keys";

// RFC 0007: these five attribution/key-env constants now live at the author
// tier (`@ori-contracts/author/openrouter-auth`) so builtins can reach them
// through the public `ori` SDK surface. Re-exported here so this module's other
// (host-only OAuth/login) consumers keep importing the full surface unchanged.
export {
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_API_KEY_MISSING_MESSAGE,
  ORI_APP_HTTP_REFERER,
  ORI_APP_TITLE,
  ORI_OPENROUTER_ATTRIBUTION_HEADERS,
} from "../../author/src/openrouter-auth.ts";

export const ORI_FORCE_OPENROUTER_API_KEY_ENV = "ORI_FORCE_OPENROUTER_API_KEY";
