import { createHash } from "node:crypto";

const OPENAI_RESPONSES_CALL_ID_MAX_LENGTH = 64;
const NORMALIZED_CALL_ID_PREFIX = "rk_";
const ENCRYPTED_CONTENT_PREFIX = "rk1.";
const LEGACY_TOOL_SEARCH_ITEM_ID_PREFIX = "ttc_";
const TOOL_SEARCH_ITEM_ID_PREFIX = "tsc_";

export type ResponsesEncryptedContentOwner = {
  provider: string;
  nativeModel: string;
};

export type ResponsesEncryptedInputPolicy =
  | { mode: "drop" }
  | { mode: "relay" }
  | {
      mode: "forward";
      owner: ResponsesEncryptedContentOwner;
      /** Keep the RouteKit wrapper for a later Chat-to-Responses provider bridge. */
      unwrap?: boolean;
    };

export type ParsedResponsesEncryptedContent = {
  owner: ResponsesEncryptedContentOwner;
  ciphertext: string;
};

export type PreparedResponsesEncryptedInput = {
  body: unknown;
  dropped: number;
};

function sameOwner(
  left: ResponsesEncryptedContentOwner,
  right: ResponsesEncryptedContentOwner
): boolean {
  return left.provider === right.provider && left.nativeModel === right.nativeModel;
}

/**
 * Repair RouteKit's legacy tool-search item prefix before replaying history to
 * a native OpenAI Responses destination. Tool outputs correlate through
 * `call_id`, so changing only the item `id` preserves the execution pair.
 */
export function repairLegacyToolSearchItemIds(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.input)) return body;

  let changed = false;
  const input = record.input.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return candidate;
    }
    const item = candidate as Record<string, unknown>;
    if (
      item.type !== "tool_search_call" ||
      typeof item.id !== "string" ||
      !item.id.startsWith(LEGACY_TOOL_SEARCH_ITEM_ID_PREFIX)
    ) {
      return candidate;
    }
    changed = true;
    return {
      ...item,
      id: `${TOOL_SEARCH_ITEM_ID_PREFIX}${item.id.slice(LEGACY_TOOL_SEARCH_ITEM_ID_PREFIX.length)}`
    };
  });

  return changed ? { ...record, input } : body;
}

/** Wrap provider-owned opaque Responses content without expanding the ciphertext itself. */
export function wrapResponsesEncryptedContent(
  ciphertext: string,
  owner: ResponsesEncryptedContentOwner
): string {
  if (parseResponsesEncryptedContent(ciphertext) !== undefined) return ciphertext;
  const encodedOwner = Buffer.from(
    JSON.stringify({ p: owner.provider, m: owner.nativeModel }),
    "utf8"
  ).toString("base64url");
  return `${ENCRYPTED_CONTENT_PREFIX}${encodedOwner}.${ciphertext}`;
}

/** Parse a RouteKit-owned encrypted-content envelope. Raw provider ciphertext is ownerless. */
export function parseResponsesEncryptedContent(
  value: unknown
): ParsedResponsesEncryptedContent | undefined {
  if (typeof value !== "string" || !value.startsWith(ENCRYPTED_CONTENT_PREFIX)) {
    return undefined;
  }
  const separator = value.indexOf(".", ENCRYPTED_CONTENT_PREFIX.length);
  if (separator === -1) return undefined;
  const encodedOwner = value.slice(ENCRYPTED_CONTENT_PREFIX.length, separator);
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

type EncryptedContentPolicyResult =
  | { action: "keep"; value: string; changed: boolean }
  | { action: "drop" };

function applyEncryptedContentPolicy(
  value: string,
  policy: ResponsesEncryptedInputPolicy
): EncryptedContentPolicyResult {
  const parsed = parseResponsesEncryptedContent(value);
  if (policy.mode === "drop") return { action: "drop" };
  if (policy.mode === "relay") {
    return parsed === undefined
      ? { action: "drop" }
      : { action: "keep", value, changed: false };
  }
  if (parsed === undefined || !sameOwner(parsed.owner, policy.owner)) {
    return { action: "drop" };
  }
  if (policy.unwrap === false) {
    return { action: "keep", value, changed: false };
  }
  return { action: "keep", value: parsed.ciphertext, changed: true };
}

type PreparedContentParts = {
  value: unknown[];
  changed: boolean;
  dropped: number;
};

function prepareEncryptedContentParts(
  parts: unknown[],
  policy: ResponsesEncryptedInputPolicy
): PreparedContentParts {
  let changed = false;
  let dropped = 0;
  const value: unknown[] = [];
  for (const candidate of parts) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      value.push(candidate);
      continue;
    }
    const part = candidate as Record<string, unknown>;
    if (
      part.type !== "encrypted_content" ||
      typeof part.encrypted_content !== "string" ||
      part.encrypted_content.length === 0
    ) {
      value.push(candidate);
      continue;
    }
    const prepared = applyEncryptedContentPolicy(
      part.encrypted_content,
      policy
    );
    if (prepared.action === "drop") {
      changed = true;
      dropped += 1;
      continue;
    }
    if (prepared.changed) {
      value.push({ ...part, encrypted_content: prepared.value });
      changed = true;
      continue;
    }
    value.push(candidate);
  }
  return { value, changed, dropped };
}

type PreparedInputItem = {
  value: unknown;
  changed: boolean;
  dropped: number;
  remove: boolean;
};

function prepareEncryptedInputItem(
  candidate: unknown,
  policy: ResponsesEncryptedInputPolicy
): PreparedInputItem {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return { value: candidate, changed: false, dropped: 0, remove: false };
  }
  const item = candidate as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type : "";
  let next = item;
  let changed = false;
  let dropped = 0;

  if (
    ENCRYPTED_CONTENT_RECORD_TYPES.has(type) &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.length > 0
  ) {
    const prepared = applyEncryptedContentPolicy(
      item.encrypted_content,
      policy
    );
    if (prepared.action === "drop") {
      if (
        type === "reasoning" ||
        type === "compaction" ||
        type === "encrypted_content"
      ) {
        return { value: candidate, changed: true, dropped: 1, remove: true };
      }
      const { encrypted_content: _encryptedContent, ...portable } = next;
      next = portable;
      changed = true;
      dropped += 1;
      if (
        (type === "message" || type === "agent_message") &&
        !Array.isArray(item.content)
      ) {
        return { value: candidate, changed: true, dropped, remove: true };
      }
      if (
        (type === "function_call_output" ||
          type === "custom_tool_call_output") &&
        !Object.hasOwn(item, "output")
      ) {
        next = { ...next, output: "" };
      }
    }
    if (prepared.action === "keep" && prepared.changed) {
      next = { ...next, encrypted_content: prepared.value };
      changed = true;
    }
  }

  if (
    (type === "message" || type === "agent_message") &&
    Array.isArray(item.content)
  ) {
    const prepared = prepareEncryptedContentParts(item.content, policy);
    dropped += prepared.dropped;
    if (prepared.changed) {
      if (prepared.value.length === 0) {
        return { value: candidate, changed: true, dropped, remove: true };
      }
      next = { ...next, content: prepared.value };
      changed = true;
    }
  }

  if (
    (type === "function_call_output" ||
      type === "custom_tool_call_output") &&
    Array.isArray(item.output)
  ) {
    const prepared = prepareEncryptedContentParts(item.output, policy);
    dropped += prepared.dropped;
    if (prepared.changed) {
      next = {
        ...next,
        output: prepared.value.length === 0 ? "" : prepared.value
      };
      changed = true;
    }
  } else if (
    (type === "function_call_output" ||
      type === "custom_tool_call_output") &&
    typeof item.output === "object" &&
    item.output !== null &&
    !Array.isArray(item.output)
  ) {
    const output = item.output as Record<string, unknown>;
    if (
      output.type === "encrypted_content" &&
      typeof output.encrypted_content === "string" &&
      output.encrypted_content.length > 0
    ) {
      const prepared = applyEncryptedContentPolicy(
        output.encrypted_content,
        policy
      );
      if (prepared.action === "drop") {
        next = { ...next, output: "" };
        changed = true;
        dropped += 1;
      } else if (prepared.changed) {
        next = {
          ...next,
          output: { ...output, encrypted_content: prepared.value }
        };
        changed = true;
      }
    }
  }

  return {
    value: changed ? next : candidate,
    changed,
    dropped,
    remove: false
  };
}

/**
 * Apply the destination policy to provider-owned Responses input without
 * mutating the request. Incompatible opaque state is removed while visible
 * messages and tool-call/output carriers remain in the portable transcript.
 */
export function prepareResponsesEncryptedInput(
  body: unknown,
  policy: ResponsesEncryptedInputPolicy
): PreparedResponsesEncryptedInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { body, dropped: 0 };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.input)) return { body, dropped: 0 };

  let dropped = 0;
  let changed = false;
  const input: unknown[] = [];
  for (const candidate of record.input) {
    const prepared = prepareEncryptedInputItem(candidate, policy);
    dropped += prepared.dropped;
    changed ||= prepared.changed;
    if (!prepared.remove) input.push(prepared.value);
  }

  return {
    body: changed ? { ...record, input } : body,
    dropped
  };
}

type TransformResult = { value: unknown; changed: boolean };

const ENCRYPTED_CONTENT_RECORD_TYPES = new Set([
  "reasoning",
  "compaction",
  "encrypted_content",
  "message",
  "function_call_output",
  "custom_tool_call_output",
  "agent_message"
]);

function wrapEncryptedResponsesValue(
  value: unknown,
  owner: ResponsesEncryptedContentOwner
): TransformResult {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const transformed = wrapEncryptedResponsesValue(item, owner);
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
      typeof record.type === "string" &&
      ENCRYPTED_CONTENT_RECORD_TYPES.has(record.type) &&
      typeof field === "string" &&
      field.length > 0
    ) {
      const wrapped = wrapResponsesEncryptedContent(field, owner);
      output[key] = wrapped;
      changed ||= wrapped !== field;
      continue;
    }
    const transformed = wrapEncryptedResponsesValue(field, owner);
    output[key] = transformed.value;
    changed ||= transformed.changed;
  }
  return { value: changed ? output : value, changed };
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
  owner: ResponsesEncryptedContentOwner
): string {
  const lineEnding = frame.includes("\r\n") ? "\r\n" : "\n";
  const lines = frame.split(/\r?\n/);
  const data = lines.flatMap((line) => {
    const value = sseDataValue(line);
    return value === undefined ? [] : [value];
  });
  if (data.length === 0 || data.join("\n") === "[DONE]") {
    return `${frame}${delimiter}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return `${frame}${delimiter}`;
  }
  const transformed = wrapEncryptedResponsesValue(parsed, owner);
  if (!transformed.changed) return `${frame}${delimiter}`;

  let emittedData = false;
  const rewritten = lines.flatMap((line) => {
    if (sseDataValue(line) === undefined) return [line];
    if (emittedData) return [];
    emittedData = true;
    return [`data: ${JSON.stringify(transformed.value)}`];
  });
  return `${rewritten.join(lineEnding)}${delimiter}`;
}

function wrapResponsesEncryptedSse(
  source: ReadableStream<Uint8Array>,
  owner: ResponsesEncryptedContentOwner
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (match === null || match.index === undefined) break;
          const frame = buffer.slice(0, match.index);
          const delimiter = match[0];
          buffer = buffer.slice(match.index + delimiter.length);
          controller.enqueue(encoder.encode(wrapSseFrame(frame, delimiter, owner)));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.length > 0) controller.enqueue(encoder.encode(buffer));
      }
    })
  );
}

/**
 * Add ownership to encrypted Responses state emitted by a successful native
 * Responses call. Provider failures and unrelated response formats pass through.
 */
export async function wrapResponsesEncryptedResponse(
  response: Response,
  owner: ResponsesEncryptedContentOwner
): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(wrapResponsesEncryptedSse(response.body, owner), {
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
  const transformed = wrapEncryptedResponsesValue(parsed, owner);
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
