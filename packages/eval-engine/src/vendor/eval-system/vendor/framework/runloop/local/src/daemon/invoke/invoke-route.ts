// Lives apart from `daemon-server.ts` like the other route modules
// (daemon-log-routes, daemon-api-feature-routes): the server dispatches to
// route families without owning their parsing or handlers.
import { Effect, Stream } from "effect";

import { RuntimeValidationError } from "../../../../../contracts/internal/src/errors.ts";
import { decodeRuntimeCommand } from "../../../../../contracts/internal/src/runtime/command.ts";
import {
  makeJsonResponse,
  makeNdjsonStreamResponse,
} from "../core/http-response.ts";
import { RouteKitEvalDaemon } from "../core/service.ts";

const INVOKE_PATH = "/api/invoke";
const CANCEL_SUFFIX = "/cancel";

const parseRuntimeCommand = Effect.fn("RuntimeHttp.parseCommand")(function* (
  request: Request
) {
  const body = yield* Effect.tryPromise({
    catch: (cause) =>
      new RuntimeValidationError({
        cause,
        detail: "Invalid JSON request body",
      }),
    try: () => request.json() as Promise<unknown>,
  });
  return yield* decodeRuntimeCommand(body).pipe(
    Effect.mapError(
      (cause) =>
        new RuntimeValidationError({
          cause,
          detail: "Invalid runtime command",
        })
    )
  );
});

/** Parse + dispatch a `POST /api/invoke` turn, returning the NDJSON event stream. */
export const handleInvokeRequest = Effect.fn("RuntimeHttp.invoke")(function* (
  request: Request
) {
  const command = yield* parseRuntimeCommand(request);
  const daemon = yield* RouteKitEvalDaemon;
  return makeNdjsonStreamResponse(
    daemon
      .invoke(command)
      .pipe(Stream.map((event) => `${JSON.stringify(event)}\n`))
  );
});

export const handleCancelRequest = Effect.fn("RuntimeHttp.cancel")(function* (
  commandId: string
) {
  const daemon = yield* RouteKitEvalDaemon;
  yield* daemon.cancel(commandId);
  return makeJsonResponse({ ok: true });
});

export const matchCancelRequest = Effect.fn("RuntimeHttp.matchCancel")(
  function* (request: Request, url: URL) {
    if (
      request.method !== "POST" ||
      !url.pathname.startsWith(`${INVOKE_PATH}/`) ||
      !url.pathname.endsWith(CANCEL_SUFFIX)
    ) {
      return;
    }
    const commandId = url.pathname.slice(
      INVOKE_PATH.length + 1,
      -CANCEL_SUFFIX.length
    );
    if (commandId.length === 0) {
      return;
    }
    return yield* handleCancelRequest(decodeURIComponent(commandId));
  }
);
