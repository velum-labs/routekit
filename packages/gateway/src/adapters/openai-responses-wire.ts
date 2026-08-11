import { createHash } from "node:crypto";
import { StreamPump } from "../sse/stream-pump.js";

const OPENAI_RESPONSES_CALL_ID_MAX_LENGTH = 64;
const NORMALIZED_CALL_ID_PREFIX = "rk_";
const ENCRYPTED_REASONING_PREFIX = "rk1.";

export type ResponsesReasoningOwner = {
  provider: string;
  nativeModel: string;
};

export type ResponsesReasoningInputPolicy =
  | { mode: "drop" }
  | { mode: "relay" }
  | {
      mode: "forward";
      owner: ResponsesReasoningOwner;
      /** Keep the RouteKit wrapper for a later Chat-to-Responses provider bridge. */
      unwrap?: boolean;
    };

export type ParsedResponsesEncryptedContent = {
  owner: ResponsesReasoningOwner;
  ciphertext: string;
};

export type PreparedResponsesReasoningInput<Body> = {
  body: Body;
  dropped: number;
};

function sameOwner(
  left: ResponsesReasoningOwner,
  right: ResponsesReasoningOwner
): boolean {
  return left.provider === right.provider && left.nativeModel === right.nativeModel;
}

/** Wrap provider-owned opaque reasoning without expanding the ciphertext itself. */
export function wrapResponsesEncryptedContent(
  ciphertext: string,
  owner: ResponsesReasoningOwner
): string {
  if (parseResponsesEncryptedContent(ciphertext) !== undefined) return ciphertext;
  const encodedOwner = Buffer.from(
    JSON.stringify({ p: owner.provider, m: owner.nativeModel }),
    "utf8"
  ).toString("base64url");
  return `${ENCRYPTED_REASONING_PREFIX}${encodedOwner}.${ciphertext}`;
}

/** Parse a RouteKit-owned encrypted-reasoning envelope. Raw provider ciphertext is ownerless. */
export function parseResponsesEncryptedContent(
  value: unknown
): ParsedResponsesEncryptedContent | undefined {
  if (typeof value !== "string" || !value.startsWith(ENCRYPTED_REASONING_PREFIX)) {
    return undefined;
  }
  const separator = value.indexOf(".", ENCRYPTED_REASONING_PREFIX.length);
  if (separator === -1) return undefined;
  const encodedOwner = value.slice(ENCRYPTED_REASONING_PREFIX.length, separator);
  const ciphertext = value.slice(separator + 1);
  if (encodedOwner.length === 0 || ciphertext.length === 0) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(encodedOwner)) return undefined;
  try {
    const ownerBytes = Buffer.from(encodedOwner, "base64url");
    if (ownerBytes.toString("base64url") !== encodedOwner) return undefined;
    const parsed = JSON.parse(ownerBytes.toString("utf8")) as {
      p?: unknown;
      m?: unknown;
    };
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.p !== "string" ||
      parsed.p.length === 0 ||
      typeof parsed.m !== "string" ||
      parsed.m.length === 0
    ) {
      return undefined;
    }
    return {
      owner: { provider: parsed.p, nativeModel: parsed.m },
      ciphertext
    };
  } catch {
    return undefined;
  }
}

/**
 * Apply the destination policy to Responses input without mutating the request.
 * Incompatible reasoning items are removed while their assistant/tool carriers
 * remain in the portable transcript.
 */
export function prepareResponsesReasoningInput<Body>(
  body: Body,
  policy: ResponsesReasoningInputPolicy
): PreparedResponsesReasoningInput<Body> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { body, dropped: 0 };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.input)) return { body, dropped: 0 };

  let dropped = 0;
  let changed = false;
  const input: unknown[] = [];
  for (const candidate of record.input) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      input.push(candidate);
      continue;
    }
    const item = candidate as Record<string, unknown>;
    if (
      item.type !== "reasoning" ||
      typeof item.encrypted_content !== "string" ||
      item.encrypted_content.length === 0
    ) {
      input.push(candidate);
      continue;
    }

    const parsed = parseResponsesEncryptedContent(item.encrypted_content);
    if (policy.mode === "drop") {
      dropped += 1;
      changed = true;
      continue;
    }
    if (policy.mode === "relay") {
      if (parsed === undefined) {
        dropped += 1;
        changed = true;
        continue;
      }
      input.push(candidate);
      continue;
    }
    if (parsed === undefined || !sameOwner(parsed.owner, policy.owner)) {
      dropped += 1;
      changed = true;
      continue;
    }
    if (policy.unwrap === false) {
      input.push(candidate);
      continue;
    }
    input.push({ ...item, encrypted_content: parsed.ciphertext });
    changed = true;
  }

  return {
    body: (changed ? { ...record, input } : body) as Body,
    dropped
  };
}

type TransformResult = { value: unknown; changed: boolean };

function wrapEncryptedReasoningValue(
  value: unknown,
  owner: ResponsesReasoningOwner
): TransformResult {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const transformed = wrapEncryptedReasoningValue(item, owner);
      changed ||= transformed.changed;
      return transformed.value;
    });
    return { value: changed ? items : value, changed };
  }
  if (typeof value !== "object" || value === null) {
    return { value, changed: false };
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (
      key === "encrypted_content" &&
      record.type === "reasoning" &&
      typeof field === "string" &&
      field.length > 0
    ) {
      const wrapped = wrapResponsesEncryptedContent(field, owner);
      output[key] = wrapped;
      changed ||= wrapped !== field;
      continue;
    }
    const transformed = wrapEncryptedReasoningValue(field, owner);
    output[key] = transformed.value;
    changed ||= transformed.changed;
  }
  return { value: changed ? output : value, changed };
}

function wrapSseData(data: string, owner: ResponsesReasoningOwner): string {
  if (data === "[DONE]") return data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data;
  }
  const transformed = wrapEncryptedReasoningValue(parsed, owner);
  return transformed.changed ? JSON.stringify(transformed.value) : data;
}

function sseDataValue(line: string): string | undefined {
  if (line === "data") return "";
  if (!line.startsWith("data:")) return undefined;
  const value = line.slice("data:".length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

function wrapSseFrame(
  frame: string,
  delimiter: string,
  owner: ResponsesReasoningOwner
): string {
  const lineEnding = frame.includes("\r\n") ? "\r\n" : "\n";
  const lines = frame.split(/\r?\n/);
  const data = lines.flatMap((line) => {
    const value = sseDataValue(line);
    return value === undefined ? [] : [value];
  });
  if (data.length === 0) return `${frame}${delimiter}`;
  const wrapped = wrapSseData(data.join("\n"), owner);
  if (wrapped === data.join("\n")) return `${frame}${delimiter}`;
  let emittedData = false;
  const rewritten = lines.flatMap((line) => {
    if (sseDataValue(line) === undefined) return [line];
    if (emittedData) return [];
    emittedData = true;
    return [`data: ${wrapped}`];
  });
  return `${rewritten.join(lineEnding)}${delimiter}`;
}

function wrapResponsesReasoningSse(
  source: ReadableStream<Uint8Array>,
  owner: ResponsesReasoningOwner
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return StreamPump.frames(source, {
    onFrame(frame, delimiter, controller) {
      controller.enqueue(encoder.encode(wrapSseFrame(frame, delimiter, owner)));
    },
    onEnd() {}
  });
}

/**
 * Add ownership to encrypted reasoning emitted by a successful native
 * Responses call. Provider failures and unrelated response formats pass through.
 */
export async function wrapResponsesReasoningResponse(
  response: Response,
  owner: ResponsesReasoningOwner
): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(wrapResponsesReasoningSse(response.body, owner), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  if (!contentType.includes("json")) return response;

  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    return response;
  }
  const transformed = wrapEncryptedReasoningValue(parsed, owner);
  if (!transformed.changed) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(transformed.value), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function normalizedCallId(callId: string, attempt = 0): string {
  const hash = createHash("sha256").update(callId, "utf8");
  if (attempt > 0) hash.update(`\0${attempt}`, "utf8");
  return `${NORMALIZED_CALL_ID_PREFIX}${hash.digest("base64url")}`;
}

/** Normalize OpenAI Responses call ids without mutating the caller's request. */
export function normalizeOpenAiResponsesCallIds(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.input)) return body;

  const reserved = new Set<string>();
  const longCallIds = new Set<string>();
  for (const item of record.input) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const callId = (item as Record<string, unknown>).call_id;
    if (typeof callId !== "string") continue;
    if (callId.length <= OPENAI_RESPONSES_CALL_ID_MAX_LENGTH) reserved.add(callId);
    else longCallIds.add(callId);
  }
  if (longCallIds.size === 0) return body;

  const replacements = new Map<string, string>();
  for (const callId of [...longCallIds].sort()) {
    let attempt = 0;
    let replacement = normalizedCallId(callId);
    while (reserved.has(replacement)) {
      attempt += 1;
      replacement = normalizedCallId(callId, attempt);
    }
    replacements.set(callId, replacement);
    reserved.add(replacement);
  }

  const input = record.input.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const callId = (item as Record<string, unknown>).call_id;
    if (typeof callId !== "string") return item;
    const replacement = replacements.get(callId);
    return replacement === undefined
      ? item
      : { ...(item as Record<string, unknown>), call_id: replacement };
  });

  return { ...record, input };
}
