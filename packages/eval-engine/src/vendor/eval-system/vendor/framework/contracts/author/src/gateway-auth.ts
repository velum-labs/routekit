import type { AgentRuntimeEvent } from "./agent-event.ts";

const ROUTEKIT_EVAL_BEARER_TOKEN_ENV = "ROUTEKIT_EVAL_BEARER_TOKEN";

const ROUTEKIT_EVAL_BEARER_TOKEN_MISSING_MESSAGE =
  "ROUTEKIT_EVAL_BEARER_TOKEN is not set. Run `routekit-eval login` to authorize with Gateway, or get a key at the injected RouteKit gateway credential service and export it before sending a message.";

/**
 * The terminal event a harness yields when it refuses to invoke because no
 * Gateway key is configured — shared so every harness fails identically.
 */
const missingGatewayKeyEvent = (): AgentRuntimeEvent => ({
  payload: {
    failure: {
      code: "ROUTEKIT_EVAL_BEARER_TOKEN_MISSING",
      kind: "configuration",
      message: ROUTEKIT_EVAL_BEARER_TOKEN_MISSING_MESSAGE,
      remediation:
        "Run `routekit-eval login`, or export a valid ROUTEKIT_EVAL_BEARER_TOKEN before retrying.",
      retryable: false,
      stage: "harness",
    },
  },
  type: "session.failed",
});

// Gateway app-attribution. `HTTP-Referer` is the unique app identifier that
// creates routekit-eval's app page in Gateway rankings/analytics; `X-Gateway-Title`
// (alias `X-Title`) sets the display name. Injecting both on Gateway-routed
// requests attributes routekit-eval activity to routekit-eval instead of the spawned agent CLI.
// The referer must not be an routekit.dev URL: Gateway drops routekit.dev
// referers on API-key traffic so clients can't masquerade as its own web app.
const ROUTEKIT_EVAL_APP_HTTP_REFERER = "https://or.bot";
const ROUTEKIT_EVAL_APP_TITLE = "RouteKitEval";
const GATEWAY_REFERER_HEADER = "HTTP-Referer";
const GATEWAY_TITLE_HEADER = "X-Gateway-Title";
export const ROUTEKIT_EVAL_GATEWAY_ATTRIBUTION_HEADERS: readonly (readonly [
  string,
  string,
])[] = [
  [GATEWAY_REFERER_HEADER, ROUTEKIT_EVAL_APP_HTTP_REFERER],
  [GATEWAY_TITLE_HEADER, ROUTEKIT_EVAL_APP_TITLE],
];

export {
  ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
  ROUTEKIT_EVAL_BEARER_TOKEN_MISSING_MESSAGE,
  ROUTEKIT_EVAL_APP_HTTP_REFERER,
  ROUTEKIT_EVAL_APP_TITLE,
  missingGatewayKeyEvent,
};
