// RFC 0002 (Harness Authoring Surface) / RFC 0007: mirrors the generated SDK's
// `routekit-eval/gateway-auth` module so builtins import the same surface an external
// feature project does. Named re-exports keep the explicit surface and avoid
// the `no-barrel-file` lint.
export {
  ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
  ROUTEKIT_EVAL_BEARER_TOKEN_MISSING_MESSAGE,
  ROUTEKIT_EVAL_APP_HTTP_REFERER,
  ROUTEKIT_EVAL_APP_TITLE,
  ROUTEKIT_EVAL_GATEWAY_ATTRIBUTION_HEADERS,
  missingGatewayKeyEvent,
} from "../../../contracts/author/src/gateway-auth.ts";
