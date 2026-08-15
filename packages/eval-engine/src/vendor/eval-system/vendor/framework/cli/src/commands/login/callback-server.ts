import { Deferred, Effect, Option, Schema } from "effect";

import {
  CliFailureError,
  makeCliFailureFromCause,
} from "../../../../contracts/internal/src/errors.ts";
import { serve } from "../../../../../../runtime/node-http.ts";

export const AuthorizationCode = Schema.NonEmptyString.pipe(
  Schema.brand("AuthorizationCode")
);
export type AuthorizationCode = typeof AuthorizationCode.Type;

const decodeAuthorizationCode = Schema.decodeUnknownOption(AuthorizationCode);

const LOOPBACK_HOST = "127.0.0.1";
const EPHEMERAL_PORT = 0;
// Nothing streams through this server: the browser makes one redirect request
// and gets an immediate HTML page back. A 10s idle timeout is the right
// behaviour here, stated rather than inherited so the next reader can see it
// was decided (tools/scripts/bun-idle-timeout-audit.test.ts).
const IDLE_TIMEOUT_SECONDS = 10;
const OK_STATUS = 200;
const BAD_REQUEST_STATUS = 400;
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;
const CALLBACK_PATH = "/callback";

interface CallbackPageOptions {
  readonly body: string;
  readonly cursor?: boolean;
  readonly heading: string;
}

const CALLBACK_PAGE_STYLE = `<style>
  :root {
    color-scheme: light dark;
    --background: #fcfcfe;
    --foreground: #03080a;
    --card: #ffffff;
    --muted: #03080a08;
    --muted-foreground: #03080ab0;
    --border: #03080a14;
    --accent: #7624f4;
    --terminal-dot: #03080a30;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --background: #03080a;
      --foreground: #fcfcfe;
      --card: #080d0f;
      --muted: #fcfcfe08;
      --muted-foreground: #fcfcfea0;
      --border: #fcfcfe14;
      --accent: #c8ff00;
      --terminal-dot: #fcfcfe30;
    }
  }

  * {
    box-sizing: border-box;
  }

  html,
  body {
    margin: 0;
    min-height: 100%;
  }

  body {
    display: grid;
    min-height: 100vh;
    place-items: center;
    padding: 1.5rem;
    background: var(--background);
    color: var(--foreground);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
  }

  .terminal {
    width: min(100%, 42rem);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--card);
    box-shadow: 0 1.5rem 4rem color-mix(in srgb, var(--foreground) 8%, transparent);
  }

  .title-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.5rem;
    padding: 0 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .title-bar-dots {
    display: flex;
    gap: 0.35rem;
  }

  .title-bar-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background: var(--terminal-dot);
  }

  .terminal-body {
    padding: 2rem;
  }

  .prompt-line {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
  }

  .prompt {
    flex: none;
    color: var(--accent);
    font-weight: 700;
  }

  h1 {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(1rem, 2.5vw, 1.25rem);
    line-height: 1.35;
  }

  p {
    margin: 1rem 0 0 1.75rem;
    color: var(--muted-foreground);
    font-size: 0.875rem;
    line-height: 1.6;
  }

  code {
    color: var(--accent);
  }

  .cursor {
    display: inline-block;
    width: 0.55rem;
    height: 1em;
    margin-left: 0.35rem;
    vertical-align: -0.15em;
    background: var(--accent);
    animation: blink 1s steps(2, start) infinite;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
</style>`;

const buildPage = ({
  body,
  cursor = false,
  heading,
}: CallbackPageOptions): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RouteKitEval login</title>
    ${CALLBACK_PAGE_STYLE}
  </head>
  <body>
    <main class="terminal" aria-labelledby="page-title">
      <div class="title-bar">
        <span class="title-bar-dots" aria-hidden="true">
          <span class="title-bar-dot"></span>
          <span class="title-bar-dot"></span>
          <span class="title-bar-dot"></span>
        </span>
        <span>routekit-eval login</span>
      </div>
      <div class="terminal-body">
        <div class="prompt-line">
          <span class="prompt" aria-hidden="true">&gt;</span>
          <h1 id="page-title">${heading}</h1>
        </div>
        <p>${body}${cursor ? '<span class="cursor" aria-hidden="true"></span>' : ""}</p>
      </div>
    </main>
  </body>
</html>`;

const SUCCESS_HTML = buildPage({
  heading: "You're signed in to Gateway.",
  body: "You can close this tab and return to your terminal.",
  cursor: true,
});

const ERROR_HTML = buildPage({
  heading: "Authorization did not complete.",
  body: "Return to your terminal and run <code>routekit-eval login</code> again.",
});

interface CallbackServer {
  readonly awaitCode: Effect.Effect<AuthorizationCode, CliFailureError>;
  readonly callbackUrl: string;
  readonly port: number;
}

interface StartCallbackServerOptions {
  readonly port?: number | undefined;
}

const handleCallbackRequest = (
  request: Request,
  codeDeferred: Deferred.Deferred<AuthorizationCode, CliFailureError>
): Response => {
  const url = new URL(request.url);
  if (url.pathname !== CALLBACK_PATH) {
    return new Response(ERROR_HTML, {
      headers: HTML_HEADERS,
      status: BAD_REQUEST_STATUS,
    });
  }

  const code = decodeAuthorizationCode(url.searchParams.get("code"));
  const error = url.searchParams.get("error");

  if (Option.isSome(code)) {
    Deferred.doneUnsafe(codeDeferred, Effect.succeed(code.value));
    return new Response(SUCCESS_HTML, {
      headers: HTML_HEADERS,
      status: OK_STATUS,
    });
  }

  if (error !== null) {
    Deferred.doneUnsafe(
      codeDeferred,
      new CliFailureError({
        detail: `Gateway authorization failed: ${error}`,
      })
    );
  }

  return new Response(ERROR_HTML, {
    headers: HTML_HEADERS,
    status: BAD_REQUEST_STATUS,
  });
};

/**
 * Start a scoped loopback HTTP server that captures the OAuth `?code` redirect.
 * `awaitCode` resolves once the browser hits the callback URL; closing the scope
 * stops the server.
 */
export const startCallbackServer = Effect.fn(
  "CallbackServer.startCallbackServer"
)(function* (options: StartCallbackServerOptions = {}) {
  const { codeDeferred, server } = yield* Effect.acquireRelease(
    Effect.tryPromise({
      catch: makeCliFailureFromCause(
        "Failed to start the local OAuth callback server"
      ),
      try: async () => {
        const deferred = Deferred.makeUnsafe<
          AuthorizationCode,
          CliFailureError
        >();
        const startedServer = await serve({
          fetch: (request) => handleCallbackRequest(request, deferred),
          hostname: LOOPBACK_HOST,
          idleTimeout: IDLE_TIMEOUT_SECONDS,
          port: options.port ?? EPHEMERAL_PORT,
        });
        return {
          codeDeferred: deferred,
          server: startedServer,
        };
      },
    }),
    ({ server: startedServer }) =>
      Effect.sync(() => {
        startedServer.stop(true);
      })
  );

  const { port } = server;
  if (port === undefined) {
    return yield* new CliFailureError({
      detail: "The local OAuth callback server did not report a port.",
    });
  }

  return {
    awaitCode: Deferred.await(codeDeferred),
    callbackUrl: `http://${LOOPBACK_HOST}:${port}/callback`,
    port,
  } satisfies CallbackServer;
});

export type { CallbackServer, StartCallbackServerOptions };
