import { Readable, Transform } from "node:stream";
import type { RequestAttribution } from "@velum-labs/routekit-contracts";
import { type RouteKitPlatform, routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect, Scope } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import * as HttpEffect from "effect/unstable/http/HttpEffect";

import { effectiveModel, isStream } from "./adapters/chat.js";
import type { BackendRequest, BackendRequestOptions } from "./backend.js";
import { gatewayTry } from "./effect/gateway.js";
import { gatewayErrorPayload } from "./gateway-errors.js";
import type { GatewayDialect, ModelGatewayCallContext, ProvenanceSink } from "./provenance.js";
import { buildModelCallRecord, MODEL_CALL_ID_HEADER, modelCallId } from "./provenance.js";

export type ModelCallRoute = {
  dialect: GatewayDialect;
  body: unknown;
  defaultModel: string | undefined;
  requestedModel?: string;
  endpointId?: string;
  attribution?: Partial<RequestAttribution>;
  /** Trusted data-plane principal from the switching proxy. */
  principal?: NonNullable<RequestAttribution["principal"]>;
  invoke: (
    callId: string,
    signal: AbortSignal,
    onAttribution: NonNullable<BackendRequestOptions["onAttribution"]>
  ) => BackendRequest;
};

export function collectAttribution(seed: Partial<RequestAttribution> | undefined): {
  report: NonNullable<BackendRequestOptions["onAttribution"]>;
  snapshot(): RequestAttribution | undefined;
} {
  let current = { ...seed };
  let attempts = 0;
  let retries = 0;
  let accountFailovers = 0;
  const operations = new Map<string, { attempts: number; lastSeat?: string }>();
  return {
    report: (update) => {
      if (update.accountAttempt !== undefined) {
        const attempt = update.accountAttempt;
        const operation = operations.get(attempt.operationId) ?? { attempts: 0 };
        attempts += 1;
        if (operation.attempts > 0) retries += 1;
        if (operation.lastSeat !== undefined && operation.lastSeat !== attempt.seat) {
          accountFailovers += 1;
        }
        operations.set(attempt.operationId, {
          attempts: operation.attempts + 1,
          lastSeat: attempt.seat
        });
        current = { ...current, account: { seat: attempt.seat } };
      }
      const { accountAttempt: _accountAttempt, ...attribution } = update;
      current = { ...current, ...attribution };
    },
    snapshot: () => {
      if (
        current.effective_model === undefined ||
        current.provider === undefined ||
        current.billing_mode === undefined
      ) {
        return undefined;
      }
      return {
        effective_model: current.effective_model,
        ...(current.native_model !== undefined ? { native_model: current.native_model } : {}),
        provider: current.provider,
        billing_mode: current.billing_mode,
        ...(current.account !== undefined ? { account: current.account } : {}),
        ...(current.principal !== undefined ? { principal: current.principal } : {}),
        ...(current.auto_routing !== undefined ? { auto_routing: current.auto_routing } : {}),
        attempts: Math.max(1, attempts),
        retries,
        account_failovers: accountFailovers
      };
    }
  };
}

const PROVENANCE_BODY_CAP_BYTES = 2 * 1024 * 1024;

function headerRecord(
  extra: Readonly<Record<string, string>>,
  contentType: string | null
): Record<string, string> {
  return {
    ...extra,
    ...(contentType !== null ? { "content-type": contentType } : {})
  };
}

/**
 * Stream an upstream Fetch body as an Effect HTTP response, forwarding only
 * status and content-type (the historic `pipeUpstream` wire).
 */
export function streamFetchResponse(
  upstream: Response,
  extraHeaders: Readonly<Record<string, string>> = {},
  options: {
    collectBody?: boolean;
    onComplete?: (body: Buffer) => void;
    onFailure?: (error: unknown, body: Buffer) => void;
  } = {}
): HttpServerResponse.HttpServerResponse {
  const headers = headerRecord(extraHeaders, upstream.headers.get("content-type"));
  const body = upstream.body;
  if (body === null) {
    options.onComplete?.(Buffer.alloc(0));
    return HttpServerResponse.empty({ status: upstream.status, headers });
  }
  const chunks: Buffer[] = [];
  let collectedBytes = 0;
  let ended = false;
  const collected = (): Buffer => Buffer.concat(chunks);
  const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      if (options.collectBody === true && collectedBytes < PROVENANCE_BODY_CAP_BYTES) {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        collectedBytes += buf.length;
      }
      cb(null, chunk);
    }
  });
  tap.once("end", () => {
    ended = true;
    options.onComplete?.(collected());
  });
  const fail = (error: unknown): void => {
    if (ended) return;
    ended = true;
    options.onFailure?.(error, collected());
  };
  tap.once("error", fail);
  tap.once("close", () => {
    if (!source.destroyed) source.destroy();
    void body.cancel().catch(() => undefined);
  });
  source.once("error", (error) => {
    fail(error);
    tap.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  source.pipe(tap);
  return HttpServerResponse.raw(tap, { status: upstream.status, headers });
}

export function handleModelCall(
  sink: ProvenanceSink | undefined,
  route: ModelCallRoute,
  extraHeaders: Readonly<Record<string, string>> = {}
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope | RouteKitPlatform> {
  return Effect.gen(function* () {
    const callId = modelCallId();
    const attribution = collectAttribution({
      ...route.attribution,
      ...(route.principal !== undefined ? { principal: route.principal } : {})
    });
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const context: ModelGatewayCallContext = {
      callId,
      dialect: route.dialect,
      requestedModel: route.requestedModel ?? effectiveModel(route.body, route.defaultModel),
      model: effectiveModel(route.body, route.defaultModel),
      stream: isStream(route.body),
      requestBody: route.body,
      startedAt,
      endpointId:
        route.endpointId ?? effectiveModel(route.body, route.defaultModel) ?? route.dialect
    };
    const headers = { ...extraHeaders, [MODEL_CALL_ID_HEADER]: callId };
    const signal = yield* Effect.abortSignal;
    const record = (statusCode: number, responseBody: Buffer, error?: unknown): void => {
      context.attribution = attribution.snapshot();
      const result = {
        statusCode,
        responseBody,
        durationMs: Date.now() - started,
        ...(error !== undefined ? { error } : {})
      };
      sink?.onModelCall?.(buildModelCallRecord(context, result));
      sink?.onModelCallRaw?.(context, result);
    };
    const invoked = yield* gatewayTry(() => route.invoke(callId, signal, attribution.report)).pipe(
      Effect.flatten,
      Effect.map((upstream) => ({ ok: true as const, upstream })),
      Effect.catch((error) => {
        const boundaryError = routeKitError(error);
        const mapped = gatewayErrorPayload(boundaryError);
        record(mapped.statusCode, Buffer.from(JSON.stringify(mapped.body), "utf8"), boundaryError);
        return Effect.succeed({
          ok: false as const,
          response: HttpServerResponse.jsonUnsafe(mapped.body, {
            status: mapped.statusCode,
            headers: { ...headers, ...(mapped.headers ?? {}) }
          })
        });
      })
    );
    if (!invoked.ok) return invoked.response;
    const upstream = invoked.upstream;
    return HttpEffect.scopeTransferToStream(
      streamFetchResponse(upstream, headers, {
        collectBody: sink !== undefined,
        onComplete: (body) => record(upstream.status, body),
        onFailure: (error, body) => record(upstream.status, body, error)
      })
    );
  });
}

/** Execute a buffered internal model call while preserving normal call accounting. */
export function invokeObservedModelCall(
  sink: ProvenanceSink | undefined,
  route: ModelCallRoute
): BackendRequest {
  return Effect.scoped(
    Effect.gen(function* () {
      const callId = modelCallId();
      const attribution = collectAttribution(route.attribution);
      const started = Date.now();
      const context: ModelGatewayCallContext = {
        callId,
        dialect: route.dialect,
        requestedModel: route.requestedModel ?? effectiveModel(route.body, route.defaultModel),
        model: effectiveModel(route.body, route.defaultModel),
        stream: false,
        requestBody: route.body,
        startedAt: new Date(started).toISOString(),
        endpointId: route.endpointId ?? "internal"
      };
      const record = (statusCode: number, responseBody: Buffer, error?: unknown): void => {
        context.attribution = attribution.snapshot();
        const result = {
          statusCode,
          responseBody,
          durationMs: Date.now() - started,
          ...(error === undefined ? {} : { error })
        };
        sink?.onModelCall?.(buildModelCallRecord(context, result));
        sink?.onModelCallRaw?.(context, result);
      };
      const signal = yield* Effect.abortSignal;
      const response = yield* gatewayTry(() =>
        route.invoke(callId, signal, attribution.report)
      ).pipe(
        Effect.flatten,
        Effect.tapError((error) =>
          Effect.sync(() => record(502, Buffer.alloc(0), routeKitError(error)))
        )
      );
      if (sink !== undefined) {
        const observed = yield* Effect.promise(() =>
          response
            .clone()
            .arrayBuffer()
            .then(
              (body) => ({ ok: true as const, body: Buffer.from(body) }),
              (error: unknown) => ({ ok: false as const, error })
            )
        );
        if (observed.ok) record(response.status, observed.body);
        else record(response.status, Buffer.alloc(0), observed.error);
      }
      return response;
    })
  );
}
