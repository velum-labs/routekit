import type { IncomingMessage, ServerResponse } from "node:http";

import { writeJson } from "./http-response.js";

export const NO_BODY = Symbol("no-body");
export const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
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
}

/**
 * Read and parse a JSON request body. On malformed JSON, write a 400 and
 * return the NO_BODY sentinel so the caller stops processing.
 */
export async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    req.resume();
    writeJson(res, 413, {
      error: { message: "request body exceeds the 16 MiB limit", type: "payload_too_large" }
    });
    return NO_BODY;
  }
  let buffer: Buffer;
  try {
    buffer = await readBody(req);
  } catch (error) {
    if (!(error instanceof RequestBodyTooLargeError)) throw error;
    writeJson(res, 413, {
      error: { message: "request body exceeds the 16 MiB limit", type: "payload_too_large" }
    });
    return NO_BODY;
  }
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    writeJson(res, 400, { error: { message: "invalid JSON body", type: "bad_request" } });
    return NO_BODY;
  }
}
