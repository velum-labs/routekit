/** HTTP client and NDJSON stream consumer for the control plane. */
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { runRouteKitEffect } from "../effect/effect-runtime.js";
import { routeKitError } from "../effect/errors.js";
import { executeWebRequest } from "../effect/http.js";
import type {
  ControlEvent,
  ControlFailure,
  ControlRequest,
  ControlResponse,
  ControlTransport
} from "./control-protocol.js";
import {
  CONTROL_BODY_LIMIT_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlError
} from "./control-protocol.js";

export type ControlClientOptions = {
  url?: string;
  token?: string;
  packageVersion?: string;
  cwd?: string;
  timeoutMs?: number;
  transport?: ControlTransport;
};

function jsonBody<T>(response: Response): Effect.Effect<T, Error> {
  return Effect.tryPromise({
    try: () => response.json() as Promise<T>,
    catch: (cause) => routeKitError(cause)
  });
}

export class HttpControlTransport implements ControlTransport {
  readonly #url: string;
  readonly #token: string;

  constructor(options: { url: string; token: string }) {
    this.#url = options.url;
    this.#token = options.token;
  }

  health(signal: AbortSignal): Effect.Effect<Response, Error, HttpClient.HttpClient> {
    return executeWebRequest(`${this.#url}/control/v2/health`, {
      headers: { authorization: `Bearer ${this.#token}` },
      signal
    }).pipe(Effect.mapError((error) => routeKitError(error)));
  }

  call(
    request: ControlRequest,
    signal: AbortSignal
  ): Effect.Effect<Response, Error, HttpClient.HttpClient> {
    return executeWebRequest(`${this.#url}/control/v2/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request),
      signal
    }).pipe(Effect.mapError((error) => routeKitError(error)));
  }

  stream(
    request: ControlRequest,
    signal: AbortSignal
  ): Effect.Effect<Response, Error, HttpClient.HttpClient> {
    return executeWebRequest(`${this.#url}/control/v2/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        accept: "application/x-ndjson"
      },
      body: JSON.stringify(request),
      signal
    }).pipe(Effect.mapError((error) => routeKitError(error)));
  }
}

export class ControlClient {
  readonly #options: ControlClientOptions;
  readonly #transport: ControlTransport;

  constructor(options: ControlClientOptions) {
    if (
      options.transport === undefined &&
      (options.url === undefined || options.token === undefined)
    ) {
      throw new Error("control client requires a transport or url and token");
    }
    this.#options = options;
    this.#transport =
      options.transport ??
      new HttpControlTransport({ url: options.url as string, token: options.token as string });
  }

  health(): Effect.Effect<{ protocol: string; version?: string }, Error, HttpClient.HttpClient> {
    const transport = this.#transport;
    const timeoutMs = this.#options.timeoutMs ?? 2_000;
    return Effect.gen(function* () {
      const response = yield* transport.health(AbortSignal.timeout(timeoutMs));
      if (!response.ok) {
        return yield* Effect.fail(new Error(`control health failed (${response.status})`));
      }
      const body = yield* jsonBody<{ protocol?: string; version?: string }>(response);
      if (typeof body.protocol !== "string") {
        return yield* Effect.fail(new Error("invalid control health response"));
      }
      return {
        protocol: body.protocol,
        ...(typeof body.version === "string" ? { version: body.version } : {})
      };
    });
  }

  call<T = unknown>(
    method: string,
    params?: unknown,
    options: { idempotencyKey?: string; signal?: AbortSignal; requestId?: string } = {}
  ): Effect.Effect<T, Error, HttpClient.HttpClient> {
    const id = options.requestId ?? randomBytes(12).toString("hex");
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 30_000);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    const request: ControlRequest = {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
      client: {
        ...(this.#options.packageVersion !== undefined
          ? { version: this.#options.packageVersion }
          : {}),
        ...(this.#options.cwd !== undefined ? { cwd: this.#options.cwd } : {})
      }
    };
    const transport = this.#transport;
    return Effect.gen(function* () {
      const response = yield* transport.call(request, signal);
      const body = yield* jsonBody<ControlResponse>(response);
      if (
        body.protocol !== CONTROL_PROTOCOL_VERSION ||
        body.id !== id ||
        typeof body.ok !== "boolean"
      ) {
        return yield* Effect.fail(new Error("invalid control response"));
      }
      if (!body.ok) {
        return yield* Effect.fail(
          new ControlError({
            code: body.error.code,
            message: body.error.message,
            status: response.status,
            ...(body.error.details !== undefined ? { details: body.error.details } : {})
          })
        );
      }
      return body.result as T;
    });
  }

  async *stream<T = unknown>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal; requestId?: string } = {}
  ): AsyncIterable<T> {
    const id = options.requestId ?? randomBytes(12).toString("hex");
    const request: ControlRequest = {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      client: {
        ...(this.#options.packageVersion !== undefined
          ? { version: this.#options.packageVersion }
          : {}),
        ...(this.#options.cwd !== undefined ? { cwd: this.#options.cwd } : {})
      }
    };
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 30_000);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    const response = await runRouteKitEffect(this.#transport.stream(request, signal));
    if (!response.ok || response.body === null) {
      try {
        const failure = (await response.json()) as ControlFailure;
        if (failure.ok === false) {
          throw new ControlError({
            code: failure.error.code,
            message: failure.error.message,
            status: response.status,
            ...(failure.error.details !== undefined ? { details: failure.error.details } : {})
          });
        }
      } catch (error) {
        if (error instanceof ControlError) throw error;
      }
      throw new Error(`control stream failed (${response.status})`);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    let terminal = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += value;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) {
            if (Buffer.byteLength(pending, "utf8") > CONTROL_BODY_LIMIT_BYTES) {
              throw new Error("control stream event exceeds the size limit");
            }
            break;
          }
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length === 0) continue;
          if (Buffer.byteLength(line, "utf8") > CONTROL_BODY_LIMIT_BYTES) {
            throw new Error("control stream event exceeds the size limit");
          }
          const event = JSON.parse(line) as ControlEvent;
          if (event.id !== id || event.protocol !== CONTROL_PROTOCOL_VERSION) {
            throw new Error("invalid control event");
          }
          if (event.event === "data") yield event.data as T;
          if (event.event === "error") {
            terminal = true;
            throw new ControlError({
              code: event.error?.code ?? "internal",
              message: event.error?.message ?? "control stream failed",
              ...(event.error?.details !== undefined ? { details: event.error.details } : {})
            });
          }
          if (event.event === "done") {
            terminal = true;
            return;
          }
        }
      }
      if (pending.length > 0) throw new Error("control stream ended with a partial event");
      if (!terminal) throw new Error("control stream ended without a terminal event");
    } finally {
      if (!terminal) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
