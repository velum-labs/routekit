/** Shared wire contracts and authentication primitives for the control plane. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

export const CONTROL_PROTOCOL_VERSION = "control.v2";
export const CONTROL_BODY_LIMIT_BYTES = 1024 * 1024;

export type ControlErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "internal"
  | "upgrade_required";

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(input: {
    code: ControlErrorCode;
    message: string;
    status?: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "ControlError";
    this.code = input.code;
    this.status = input.status ?? statusForCode(input.code);
    this.details = input.details;
  }
}
function statusForCode(code: ControlErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "upgrade_required":
      return 426;
    case "unavailable":
      return 503;
    case "internal":
      return 500;
  }
}
export type ControlRequest = {
  protocol: string;
  id: string;
  method: string;
  params?: unknown;
  idempotencyKey?: string;
  client?: { version?: string; cwd?: string };
};

export type ControlSuccess = {
  protocol: string;
  id: string;
  ok: true;
  result: unknown;
};

export type ControlFailure = {
  protocol: string;
  id: string;
  ok: false;
  error: { code: ControlErrorCode; message: string; details?: unknown };
};

export type ControlResponse = ControlSuccess | ControlFailure;

export type ControlEvent = {
  protocol: string;
  id: string;
  event: "data" | "done" | "error";
  data?: unknown;
  error?: ControlFailure["error"];
};

/** Identity of the control-plane caller, when known. */
export type ControlPrincipal = {
  id: string;
  label: string;
  role: "owner" | "admin" | "ephemeral";
};

export type ControlHandlerContext = {
  signal: AbortSignal;
  requestId: string;
  idempotencyKey?: string;
  client?: ControlRequest["client"];
  /** Present when the request authenticated with a recognizable credential. */
  principal?: ControlPrincipal;
};

export type ControlHandler = (
  method: string,
  params: unknown,
  context: ControlHandlerContext
) => unknown | Promise<unknown> | AsyncIterable<unknown>;

export type RunningControlServer = {
  url: string;
  token: string;
  port: number;
  retire(graceMs?: number): Promise<void>;
  close(): Promise<void>;
};

export type ControlServerErrorContext = {
  requestId: string;
  method?: string;
};

export type ControlClientOptions = {
  url?: string;
  token?: string;
  packageVersion?: string;
  cwd?: string;
  timeoutMs?: number;
  transport?: ControlTransport;
};

export type ControlTransport = Readonly<{
  health(signal: AbortSignal): Effect.Effect<Response, Error, HttpClient.HttpClient>;
  call(
    request: ControlRequest,
    signal: AbortSignal
  ): Effect.Effect<Response, Error, HttpClient.HttpClient>;
  stream(request: ControlRequest, signal: AbortSignal): Promise<Response>;
}>;

export function generateControlToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function controlTokenMatches(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  return timingSafeEqual(digest(expected), digest(candidate));
}
