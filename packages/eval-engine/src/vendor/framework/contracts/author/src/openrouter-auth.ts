import type { AgentRuntimeEvent } from "./agent-event.ts";

const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

const OPENROUTER_API_KEY_MISSING_MESSAGE =
  "OPENROUTER_API_KEY is not set. Run `ori login` to authorize with OpenRouter, or get a key at https://openrouter.ai/keys and export it before sending a message.";

/**
 * The terminal event a harness yields when it refuses to invoke because no
 * OpenRouter key is configured — shared so every harness fails identically.
 */
const missingOpenRouterKeyEvent = (): AgentRuntimeEvent => ({
  payload: {
    failure: {
      code: "ORI_OPENROUTER_API_KEY_MISSING",
      kind: "configuration",
      message: OPENROUTER_API_KEY_MISSING_MESSAGE,
      remediation:
        "Run `ori login`, or export a valid OPENROUTER_API_KEY before retrying.",
      retryable: false,
      stage: "harness",
    },
  },
  type: "session.failed",
});

// OpenRouter app-attribution. `HTTP-Referer` is the unique app identifier that
// creates ori's app page in OpenRouter rankings/analytics; `X-OpenRouter-Title`
// (alias `X-Title`) sets the display name. Injecting both on OpenRouter-routed
// requests attributes ori activity to ori instead of the spawned agent CLI.
// The referer must not be an openrouter.ai URL: OpenRouter drops openrouter.ai
// referers on API-key traffic so clients can't masquerade as its own web app.
const ORI_APP_HTTP_REFERER = "https://or.bot";
const ORI_APP_TITLE = "Ori";
const OPENROUTER_REFERER_HEADER = "HTTP-Referer";
const OPENROUTER_TITLE_HEADER = "X-OpenRouter-Title";
export const ORI_OPENROUTER_ATTRIBUTION_HEADERS: readonly (readonly [
  string,
  string,
])[] = [
  [OPENROUTER_REFERER_HEADER, ORI_APP_HTTP_REFERER],
  [OPENROUTER_TITLE_HEADER, ORI_APP_TITLE],
];

export {
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_API_KEY_MISSING_MESSAGE,
  ORI_APP_HTTP_REFERER,
  ORI_APP_TITLE,
  missingOpenRouterKeyEvent,
};
