import type { ServerResponse } from "node:http";

import { ProviderFailureError } from "@velum-labs/routekit-contracts";
import { HttpServerResponse } from "effect/unstable/http";

import { EndpointAuthenticationError } from "./endpoints/endpoint-module.js";
import { AutoRoutingUnavailableError, EvalAutoRoutingForbiddenError } from "./eval-policy.js";
import { writeJson } from "./http-response.js";
import { NoModelAvailableError, UnknownModelError } from "./router.js";

export type GatewayErrorPayload = Readonly<{
  statusCode: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

export function gatewayErrorPayload(error: unknown): GatewayErrorPayload {
  if (error instanceof EndpointAuthenticationError) {
    return { statusCode: 401, body: { error: { message: "unauthorized", type: "auth_error" } } };
  }
  if (error instanceof NoModelAvailableError) {
    return { statusCode: 503, body: { error: { message: error.message, type: "unavailable" } } };
  }
  if (error instanceof AutoRoutingUnavailableError) {
    return { statusCode: 503, body: { error: { message: error.message, type: "unavailable" } } };
  }
  if (error instanceof EvalAutoRoutingForbiddenError) {
    return {
      statusCode: 400,
      body: {
        error: {
          message: error.message,
          type: "invalid_request_error",
          param: "model"
        }
      }
    };
  }
  if (error instanceof UnknownModelError) {
    return {
      statusCode: 400,
      body: {
        error: {
          message: error.message,
          type: "invalid_request_error",
          param: "model"
        }
      }
    };
  }
  if (error instanceof ProviderFailureError) {
    const { failure } = error;
    const retryAfter =
      failure.retryAfter ??
      (failure.resetsAt === undefined
        ? undefined
        : Math.max(0, failure.resetsAt - Date.now() / 1000));
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
    return {
      statusCode: status,
      body: {
        error: {
          message: failure.message,
          type,
          ...(failure.resetsAt !== undefined ? { resets_at: failure.resetsAt } : {})
        }
      },
      ...(retryAfter !== undefined
        ? { headers: { "retry-after": String(Math.max(0, Math.ceil(retryAfter))) } }
        : {})
    };
  }
  process.stderr.write(`routekit gateway upstream error: type=${safeErrorType(error)}\n`);
  return {
    statusCode: 502,
    body: { error: { message: "upstream request failed", type: "upstream_error" } }
  };
}

export function gatewayErrorResponse(error: unknown): HttpServerResponse.HttpServerResponse {
  const payload = gatewayErrorPayload(error);
  return HttpServerResponse.jsonUnsafe(payload.body, {
    status: payload.statusCode,
    ...(payload.headers !== undefined ? { headers: payload.headers } : {})
  });
}

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
  const mapped = gatewayErrorPayload(error);
  if (mapped.headers !== undefined && !res.headersSent) {
    for (const [name, value] of Object.entries(mapped.headers)) {
      res.setHeader(name, value);
    }
  }
  return {
    statusCode: mapped.statusCode,
    payload: writeErrorSafely(res, mapped.statusCode, mapped.body)
  };
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
