import { Effect } from "effect";

import { RuntimeValidationError } from "../../../../../contracts/internal/src/errors.ts";
import { decodeChatInteractionResponse } from "../../../../../contracts/internal/src/runtime/interaction-response.ts";
import { SelectedAdapterCoordinator } from "../../../../../engine/selected-adapter/src/coordinator.ts";
import { makeJsonResponse } from "../core/http-response.ts";

const parseInteractionResponse = Effect.fn(
  "RuntimeHttp.parseInteractionResponse"
)(function* (request: Request) {
  const body = yield* Effect.tryPromise({
    catch: (cause) =>
      new RuntimeValidationError({
        cause,
        detail: "Invalid interaction response JSON",
      }),
    try: () => request.json() as Promise<unknown>,
  });
  return yield* decodeChatInteractionResponse(body).pipe(
    Effect.mapError(
      (cause) =>
        new RuntimeValidationError({
          cause,
          detail: "Invalid interaction response",
        })
    )
  );
});

const handleInteractionResponseRequest = Effect.fn(
  "RuntimeHttp.interactionResponse"
)(function* (request: Request) {
  const response = yield* parseInteractionResponse(request);
  const coordinator = yield* SelectedAdapterCoordinator;
  yield* coordinator.respondInteraction(response).pipe(
    Effect.mapError(
      (cause) =>
        new RuntimeValidationError({
          cause,
          detail: "Interaction response was rejected",
        })
    )
  );
  return makeJsonResponse({ ok: true });
});

export { handleInteractionResponseRequest, parseInteractionResponse };
