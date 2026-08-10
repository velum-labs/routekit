/** HTTP client and NDJSON stream consumer for the control plane. */
import { randomBytes } from "node:crypto";
import type {
  ControlEvent,
  ControlFailure,
  ControlRequest,
  ControlResponse
} from "./control-protocol.js";
import {
  CONTROL_BODY_LIMIT_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlError
} from "./control-protocol.js";

export type ControlClientOptions = {
  url: string;
  token: string;
  packageVersion?: string;
  cwd?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class ControlClient {
  readonly #options: ControlClientOptions;

  constructor(options: ControlClientOptions) {
    this.#options = options;
  }

  async health(): Promise<{ protocol: string; version?: string }> {
    const response = await (this.#options.fetch ?? fetch)(
      `${this.#options.url}/control/v1/health`,
      {
        headers: { authorization: `Bearer ${this.#options.token}` },
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 2_000)
      }
    );
    if (!response.ok) throw new Error(`control health failed (${response.status})`);
    const body = (await response.json()) as { protocol?: string; version?: string };
    if (typeof body.protocol !== "string") throw new Error("invalid control health response");
    return {
      protocol: body.protocol,
      ...(typeof body.version === "string" ? { version: body.version } : {})
    };
  }

  async call<T = unknown>(
    method: string,
    params?: unknown,
    options: { idempotencyKey?: string; signal?: AbortSignal; requestId?: string } = {}
  ): Promise<T> {
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
    const response = await (this.#options.fetch ?? fetch)(`${this.#options.url}/control/v1/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#options.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request),
      signal
    });
    const body = (await response.json()) as ControlResponse;
    if (
      body.protocol !== CONTROL_PROTOCOL_VERSION ||
      body.id !== id ||
      typeof body.ok !== "boolean"
    ) {
      throw new Error("invalid control response");
    }
    if (!body.ok) {
      throw new ControlError({
        code: body.error.code,
        message: body.error.message,
        status: response.status,
        ...(body.error.details !== undefined ? { details: body.error.details } : {})
      });
    }
    return body.result as T;
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
    const response = await (this.#options.fetch ?? fetch)(`${this.#options.url}/control/v1/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#options.token}`,
        "content-type": "application/json",
        accept: "application/x-ndjson"
      },
      body: JSON.stringify(request),
      signal
    });
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
