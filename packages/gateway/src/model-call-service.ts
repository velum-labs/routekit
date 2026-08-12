import type { ServerResponse } from "node:http";

import type { RequestAttribution } from "@velum-labs/routekit-contracts";
import { StreamPump } from "@velum-labs/routekit-runtime/sse";

import { effectiveModel, isStream } from "./adapters/chat.js";
import type { BackendRequestOptions } from "./backend.js";
import { waitForDrainOrClose } from "./http-response.js";
import type { GatewayDialect, ModelGatewayCallContext, ProvenanceSink } from "./provenance.js";
import { buildModelCallRecord, MODEL_CALL_ID_HEADER, modelCallId } from "./provenance.js";
import { writeGatewayError } from "./gateway-errors.js";

export type ModelCallRoute = {
  dialect: GatewayDialect;
  body: unknown;
  defaultModel: string | undefined;
  attribution?: Partial<RequestAttribution>;
  /** Trusted data-plane principal from the switching proxy. */
  principal?: NonNullable<RequestAttribution["principal"]>;
  invoke: (
    callId: string,
    signal: AbortSignal,
    onAttribution: NonNullable<BackendRequestOptions["onAttribution"]>
  ) => Promise<Response>;
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
        attempts: Math.max(1, attempts),
        retries,
        account_failovers: accountFailovers
      };
    }
  };
}

export async function handleModelCall(
  res: ServerResponse,
  sink: ProvenanceSink | undefined,
  route: ModelCallRoute
): Promise<void> {
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
    requestedModel: effectiveModel(route.body, route.defaultModel),
    model: effectiveModel(route.body, route.defaultModel),
    stream: isStream(route.body),
    requestBody: route.body,
    startedAt,
    endpointId: effectiveModel(route.body, route.defaultModel) ?? route.dialect
  };
  res.setHeader(MODEL_CALL_ID_HEADER, callId);
  const aborter = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) aborter.abort();
  };
  res.once("close", onClose);
  try {
    const upstream = await route.invoke(callId, aborter.signal, attribution.report);
    const body = await pipeUpstream(res, upstream, sink !== undefined, aborter.signal);
    const result = {
      statusCode: upstream.status,
      responseBody: body,
      durationMs: Date.now() - started
    };
    context.attribution = attribution.snapshot();
    sink?.onModelCall?.(buildModelCallRecord(context, result));
    sink?.onModelCallRaw?.(context, result);
  } catch (error) {
    const { statusCode, payload } = writeGatewayError(res, error);
    const result = {
      statusCode,
      responseBody: payload,
      durationMs: Date.now() - started,
      error
    };
    context.attribution = attribution.snapshot();
    sink?.onModelCall?.(buildModelCallRecord(context, result));
    sink?.onModelCallRaw?.(context, result);
  } finally {
    res.off("close", onClose);
  }
}

const PROVENANCE_BODY_CAP_BYTES = 2 * 1024 * 1024;

export async function pipeUpstream(
  res: ServerResponse,
  upstream: Response,
  collectBody = false,
  signal?: AbortSignal
): Promise<Buffer> {
  res.statusCode = upstream.status;
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) res.setHeader("content-type", contentType);
  const body = upstream.body;
  if (body === null) {
    res.end();
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let collectedBytes = 0;
  try {
    await StreamPump.bytes(body, {
      ...(signal !== undefined ? { signal } : {}),
      async onChunk(value) {
        if (signal?.aborted === true || res.destroyed || res.writableEnded) return;
        const chunk = Buffer.from(value);
        if (collectBody && collectedBytes < PROVENANCE_BODY_CAP_BYTES) {
          chunks.push(chunk);
          collectedBytes += chunk.length;
        }
        if (!res.write(chunk)) await waitForDrainOrClose(res);
      }
    });
  } catch (error) {
    res.destroy();
    throw error;
  }
  if (!res.destroyed && !res.writableEnded) res.end();
  return Buffer.concat(chunks);
}
