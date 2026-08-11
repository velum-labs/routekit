/** Authenticated loopback HTTP server for the product-neutral control plane. */
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type {
  ControlEvent,
  ControlFailure,
  ControlHandler,
  ControlPrincipal,
  ControlRequest,
  ControlServerErrorContext,
  ControlSuccess,
  RunningControlServer
} from "./control-protocol.js";
import {
  CONTROL_BODY_LIMIT_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  controlTokenMatches,
  generateControlToken
} from "./control-protocol.js";

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice("Bearer ".length)
    : undefined;
}

function loopbackHost(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  const host = raw?.startsWith("[") === true ? raw.slice(1, raw.indexOf("]")) : raw?.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(payload.byteLength));
  res.setHeader("cache-control", "no-store");
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"]?.split(";")[0]?.trim();
  if (contentType !== "application/json") {
    throw new ControlError({
      code: "bad_request",
      message: "control requests require application/json"
    });
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > CONTROL_BODY_LIMIT_BYTES) {
    throw new ControlError({ code: "bad_request", message: "control request body is too large" });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    total += chunk.length;
    if (total > CONTROL_BODY_LIMIT_BYTES) {
      throw new ControlError({ code: "bad_request", message: "control request body is too large" });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ControlError({ code: "bad_request", message: "invalid control request JSON" });
  }
}

function parseRequest(value: unknown): ControlRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "control request must be an object" });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.protocol !== "string" ||
    typeof record.id !== "string" ||
    typeof record.method !== "string" ||
    record.id.length === 0 ||
    record.method.length === 0
  ) {
    throw new ControlError({
      code: "bad_request",
      message: "control request requires protocol, id, and method"
    });
  }
  return {
    protocol: record.protocol,
    id: record.id,
    method: record.method,
    ...(record.params !== undefined ? { params: record.params } : {}),
    ...(typeof record.idempotencyKey === "string" ? { idempotencyKey: record.idempotencyKey } : {}),
    ...(typeof record.client === "object" && record.client !== null
      ? { client: record.client as ControlRequest["client"] }
      : {})
  };
}

function asFailure(id: string, error: unknown): { status: number; body: ControlFailure } {
  const normalized =
    error instanceof ControlError
      ? error
      : new ControlError({ code: "internal", message: "control operation failed" });
  return {
    status: normalized.status,
    body: {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details !== undefined ? { details: normalized.details } : {})
      }
    }
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function ndjson(res: ServerResponse, event: ControlEvent): boolean {
  return res.write(`${JSON.stringify(event)}\n`);
}

export async function startControlServer(input: {
  handler: ControlHandler;
  token?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  product?: string;
  packageVersion?: string;
  capabilities?: readonly string[];
  /**
   * Optional secondary authorizer for durable control-plane tokens (registry).
   * The per-start ephemeral token always remains valid.
   */
  authorize?: (presented: string) => ControlPrincipal | undefined;
  /** Observe unexpected handler/transport failures without exposing them to clients. */
  onError?: (error: unknown, context: ControlServerErrorContext) => void;
}): Promise<RunningControlServer> {
  const host = input.host ?? "127.0.0.1";
  const token = input.token ?? generateControlToken();
  const reportError = (error: unknown, context: ControlServerErrorContext): void => {
    try {
      input.onError?.(error, context);
    } catch {
      // Observability must never change the control response or crash the server.
    }
  };
  const resolveCaller = (presented: string | undefined): ControlPrincipal | undefined => {
    if (presented === undefined) return undefined;
    if (controlTokenMatches(token, presented)) {
      return { id: "ephemeral", label: "local", role: "ephemeral" };
    }
    return input.authorize?.(presented);
  };
  const server = createServer((req, res) => {
    void (async () => {
      if (!loopbackHost(req)) {
        writeJson(res, 403, { error: { code: "unauthorized", message: "invalid control host" } });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const principal = resolveCaller(bearer(req));
      if (principal === undefined) {
        writeJson(res, 401, { error: { code: "unauthorized", message: "unauthorized" } });
        return;
      }
      if (req.method === "GET" && url.pathname === "/control/v1/health") {
        writeJson(res, 200, {
          status: "ok",
          protocol: CONTROL_PROTOCOL_VERSION,
          product: input.product,
          version: input.packageVersion
        });
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/control/v1/call") {
        writeJson(res, 404, { error: { code: "not_found", message: "control route not found" } });
        return;
      }
      let requestId = "unknown";
      let requestMethod: string | undefined;
      try {
        const request = parseRequest(await readJson(req));
        requestId = request.id;
        requestMethod = request.method;
        if (request.protocol !== CONTROL_PROTOCOL_VERSION) {
          throw new ControlError({
            code: "upgrade_required",
            message: `unsupported control protocol ${request.protocol}`,
            details: { supported: [CONTROL_PROTOCOL_VERSION] }
          });
        }
        if (request.method === "hello") {
          writeJson(res, 200, {
            protocol: CONTROL_PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            result: {
              protocolVersion: CONTROL_PROTOCOL_VERSION,
              product: input.product,
              packageVersion: input.packageVersion,
              capabilities: input.capabilities ?? []
            }
          } satisfies ControlSuccess);
          return;
        }
        const aborter = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) aborter.abort(new Error("control client disconnected"));
        };
        res.once("close", onClose);
        try {
          const result = await input.handler(request.method, request.params, {
            signal: aborter.signal,
            requestId: request.id,
            principal,
            ...(request.idempotencyKey !== undefined
              ? { idempotencyKey: request.idempotencyKey }
              : {}),
            ...(request.client !== undefined ? { client: request.client } : {})
          });
          if (isAsyncIterable(result)) {
            res.statusCode = 200;
            res.setHeader("content-type", "application/x-ndjson");
            res.setHeader("cache-control", "no-store");
            const iterator = result[Symbol.asyncIterator]();
            const disconnected = new Promise<IteratorResult<unknown>>((resolve) => {
              aborter.signal.addEventListener(
                "abort",
                () => resolve({ done: true, value: undefined }),
                { once: true }
              );
            });
            try {
              while (!aborter.signal.aborted) {
                const next = await Promise.race([iterator.next(), disconnected]);
                if (next.done) break;
                if (
                  !ndjson(res, {
                    protocol: CONTROL_PROTOCOL_VERSION,
                    id: request.id,
                    event: "data",
                    data: next.value
                  })
                ) {
                  await Promise.race([once(res, "drain"), once(res, "close")]);
                }
              }
            } finally {
              if (aborter.signal.aborted) {
                await Promise.race([
                  iterator.return?.(),
                  new Promise((resolve) => setTimeout(resolve, 1_000))
                ]).catch(() => undefined);
              }
            }
            if (!aborter.signal.aborted) {
              ndjson(res, {
                protocol: CONTROL_PROTOCOL_VERSION,
                id: request.id,
                event: "done"
              });
              res.end();
            }
          } else {
            writeJson(res, 200, {
              protocol: CONTROL_PROTOCOL_VERSION,
              id: request.id,
              ok: true,
              result
            } satisfies ControlSuccess);
          }
        } finally {
          res.off("close", onClose);
        }
      } catch (error) {
        if (!(error instanceof ControlError)) {
          reportError(error, {
            requestId,
            ...(requestMethod !== undefined ? { method: requestMethod } : {})
          });
        }
        const failure = asFailure(requestId, error);
        if (!res.headersSent) writeJson(res, failure.status, failure.body);
        else if (!res.writableEnded) {
          ndjson(res, {
            protocol: CONTROL_PROTOCOL_VERSION,
            id: requestId,
            event: "error",
            error: failure.body.error
          });
          res.end();
        }
      }
    })().catch((error: unknown) => {
      reportError(error, { requestId: "unknown" });
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: { code: "internal", message: "control request failed" }
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (input.port ?? 0);
  let retireRun: Promise<void> | undefined;
  const retire = (graceMs = 2_000): Promise<void> => {
    retireRun ??= (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
      server.closeAllConnections();
      await closed;
    })();
    return retireRun;
  };
  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    token,
    port,
    retire,
    close: async () => await retire(2_000)
  };
}
