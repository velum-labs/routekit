import type { ServerResponse } from "node:http";

import { ProviderFailureError } from "@velum-labs/routekit-contracts";

import { EndpointAuthenticationError } from "./endpoints/endpoint-module.js";
import { writeJson } from "./http-response.js";
import { NoModelAvailableError, UnknownModelError } from "./router.js";

/**
 * Report an error on a response that may already be mid-stream. Once headers
 * are sent, destroy the socket rather than attempting to write a second
 * response.
 */
export function writeErrorSafely(res: ServerResponse, status: number, value: unknown): Buffer {
  try {
    if (!res.headersSent) return writeJson(res, status, value);
    if (!res.writableEnded) res.destroy();
  } catch {
    // Last resort: nothing useful can be written, but the gateway stays alive.
  }
  return Buffer.alloc(0);
}

export function writeGatewayError(
  res: ServerResponse,
  error: unknown
): { statusCode: number; payload: Buffer } {
  if (error instanceof EndpointAuthenticationError) {
    const payload = writeErrorSafely(res, 401, {
      error: { message: "unauthorized", type: "auth_error" }
    });
    return { statusCode: 401, payload };
  }
  if (error instanceof NoModelAvailableError) {
    const payload = writeErrorSafely(res, 503, {
      error: { message: error.message, type: "unavailable" }
    });
    return { statusCode: 503, payload };
  }
  if (error instanceof UnknownModelError) {
    const payload = writeErrorSafely(res, 400, {
      error: {
        message: error.message,
        type: "invalid_request_error",
        param: "model"
      }
    });
    return { statusCode: 400, payload };
  }
  if (error instanceof ProviderFailureError) {
    const { failure } = error;
    const retryAfter =
      failure.retryAfter ??
      (failure.resetsAt === undefined
        ? undefined
        : Math.max(0, failure.resetsAt - Date.now() / 1000));
    if (retryAfter !== undefined && !res.headersSent) {
      res.setHeader("retry-after", Math.max(0, Math.ceil(retryAfter)));
    }
    let status: number;
    let type: string;
    switch (failure.category) {
      case "quota_exhausted":
        status = 429;
        type = "rate_limit_error";
        break;
      case "auth_permanent":
        status = 502;
        type = "provider_auth_error";
        break;
      case "auth_transient":
        status = 503;
        type = "provider_auth_recovery_error";
        break;
      case "transient":
        status = 503;
        type = "upstream_error";
        break;
      case "context_overflow":
        status = 400;
        type = "context_length_exceeded";
        break;
      case "unknown":
        status = 502;
        type = "upstream_error";
        break;
      default: {
        const unreachable: never = failure.category;
        throw new Error(`unhandled provider failure category: ${String(unreachable)}`);
      }
    }
    const payload = writeErrorSafely(res, status, {
      error: {
        message: failure.message,
        type,
        ...(failure.resetsAt !== undefined ? { resets_at: failure.resetsAt } : {})
      }
    });
    return { statusCode: status, payload };
  }
  process.stderr.write(`routekit gateway upstream error: type=${safeErrorType(error)}\n`);
  const payload = writeErrorSafely(res, 502, {
    error: { message: "upstream request failed", type: "upstream_error" }
  });
  return { statusCode: 502, payload };
}

function safeErrorType(error: unknown): string {
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof ReferenceError) return "ReferenceError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof URIError) return "URIError";
  if (error instanceof Error) return "Error";
  return "NonError";
}
