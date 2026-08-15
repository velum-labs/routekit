// RFC 0002 (Harness Authoring Surface) / RFC 0007: mirrors the generated SDK's
// `ori/openrouter-auth` module so builtins import the same surface an external
// feature project does. Named re-exports keep the explicit surface and avoid
// the `no-barrel-file` lint.
export {
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_API_KEY_MISSING_MESSAGE,
  ORI_APP_HTTP_REFERER,
  ORI_APP_TITLE,
  ORI_OPENROUTER_ATTRIBUTION_HEADERS,
  missingOpenRouterKeyEvent,
} from "../../../contracts/author/src/openrouter-auth.ts";
