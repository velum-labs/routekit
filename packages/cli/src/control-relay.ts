import type {
  ControlFailure,
  ControlRequest,
  ControlResponse,
  ServiceRecord
} from "@velum-labs/routekit-runtime";
import { CONTROL_BODY_LIMIT_BYTES, CONTROL_PROTOCOL_VERSION } from "@velum-labs/routekit-runtime";
import {
  executeWebRequest,
  RouteKitFailure,
  routeKitError
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

import { readDaemonRecord } from "./client.js";
import { readDaemonPublicRecord, readPeerPointer } from "./peer.js";

export type ControlRelayEnvelope = { kind: "health" } | { kind: "call"; request: ControlRequest };

export type ControlRelayResult = { status: number; body: unknown };

function failure(
  status: number,
  id: string,
  code: ControlFailure["error"]["code"],
  message: string
): ControlRelayResult {
  return {
    status,
    body: {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message }
    } satisfies ControlFailure
  };
}

type RelayTarget = {
  url: string;
  controlToken: string;
};

function controlTarget(): RelayTarget | undefined {
  const record = readDaemonRecord();
  if (record?.controlToken !== undefined) {
    return { url: record.url, controlToken: record.controlToken };
  }
  const peer = readPeerPointer();
  if (peer === undefined) return undefined;
  try {
    const pub = readDaemonPublicRecord(peer.publicRecordPath);
    return { url: pub.url, controlToken: peer.controlToken };
  } catch {
    return undefined;
  }
}

/** Expose the local service record when this account owns the daemon. */
export function controlRecord(): ServiceRecord | undefined {
  const record = readDaemonRecord();
  return record?.controlToken === undefined ? undefined : record;
}

export function parseControlRelayEnvelope(value: unknown): ControlRelayEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid control relay request");
  }
  const envelope = value as { kind?: unknown; request?: unknown };
  if (envelope.kind === "health") return { kind: "health" };
  if (
    envelope.kind !== "call" ||
    typeof envelope.request !== "object" ||
    envelope.request === null ||
    Array.isArray(envelope.request)
  ) {
    throw new Error("invalid control relay request");
  }
  const request = envelope.request as Partial<ControlRequest>;
  if (
    request.protocol !== CONTROL_PROTOCOL_VERSION ||
    typeof request.id !== "string" ||
    typeof request.method !== "string"
  ) {
    throw new Error("invalid control relay request");
  }
  return { kind: "call", request: request as ControlRequest };
}

export function relayLocalControl(
  envelope: ControlRelayEnvelope
): Effect.Effect<ControlRelayResult, Error, HttpClient.HttpClient> {
  const target = controlTarget();
  if (target === undefined) {
    return Effect.succeed(
      envelope.kind === "health"
        ? {
            status: 503,
            body: {
              error: { code: "unavailable", message: "RouteKit daemon is not running" }
            }
          }
        : failure(503, envelope.request.id, "unavailable", "RouteKit daemon is not running")
    );
  }
  return Effect.gen(function* () {
    const response = yield* executeWebRequest(
      envelope.kind === "health"
        ? `${target.url}/control/v2/health`
        : `${target.url}/control/v2/call`,
      envelope.kind === "health"
        ? { headers: { authorization: `Bearer ${target.controlToken}` } }
        : {
            method: "POST",
            headers: {
              authorization: `Bearer ${target.controlToken}`,
              "content-type": "application/json"
            },
            body: JSON.stringify(envelope.request)
          }
    ).pipe(Effect.mapError((error) => routeKitError(error)));
    const fallback =
      envelope.kind === "call"
        ? failure(500, envelope.request.id, "internal", "invalid local control response").body
        : { error: { code: "internal", message: "invalid local control response" } };
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new RouteKitFailure({ message: "invalid local control response" })
    }).pipe(Effect.orElseSucceed(() => fallback));
    return { status: response.status, body: body as ControlResponse | unknown };
  });
}

export async function readControlRelayStdin(): Promise<ControlRelayEnvelope> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    size += chunk.byteLength;
    if (size > CONTROL_BODY_LIMIT_BYTES) {
      throw new Error("control relay request is too large");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength > CONTROL_BODY_LIMIT_BYTES) {
    throw new Error("control relay request is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid control relay JSON");
  }
  return parseControlRelayEnvelope(parsed);
}
