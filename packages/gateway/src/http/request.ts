import type { IncomingMessage } from "node:http";
import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

export const NO_BODY: unique symbol = Symbol("no-body");
export const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {}

function readBody(req: IncomingMessage) {
  return Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      for await (const value of req) {
        const chunk = value as Buffer;
        total += chunk.length;
        if (total > MAX_REQUEST_BODY_BYTES) {
          tooLarge = true;
          continue;
        }
        chunks.push(chunk);
      }
      if (tooLarge) throw new RequestBodyTooLargeError();
      return Buffer.concat(chunks);
    },
    catch: toRouteKitFailure
  });
}

/**
 * Read and parse a JSON request body. On malformed JSON or an oversized body,
 * write the matching error through `writeError` and return the NO_BODY sentinel
 * so the caller stops processing.
 */
export function readJson(
  req: IncomingMessage,
  writeError: (status: number, value: unknown) => void
): Effect.Effect<unknown, Error> {
  return Effect.gen(function* () {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
      req.resume();
      writeError(413, {
        error: { message: "request body exceeds the 16 MiB limit", type: "payload_too_large" }
      });
      return NO_BODY;
    }
    const body = yield* readBody(req).pipe(
      Effect.catch((error) => {
        if (!(error.cause instanceof RequestBodyTooLargeError)) return Effect.fail(error);
        return Effect.sync(() => {
          writeError(413, {
            error: { message: "request body exceeds the 16 MiB limit", type: "payload_too_large" }
          });
          return NO_BODY;
        });
      })
    );
    if (typeof body === "symbol") return NO_BODY;
    const buffer = body;
    if (buffer.length === 0) return {};
    return yield* Effect.sync(() => {
      try {
        return JSON.parse(buffer.toString("utf8")) as unknown;
      } catch {
        writeError(400, { error: { message: "invalid JSON body", type: "bad_request" } });
        return NO_BODY;
      }
    });
  });
}
