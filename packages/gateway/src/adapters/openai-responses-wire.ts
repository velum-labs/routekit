import { createHash } from "node:crypto";

const OPENAI_RESPONSES_CALL_ID_MAX_LENGTH = 64;
const NORMALIZED_CALL_ID_PREFIX = "rk_";

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
