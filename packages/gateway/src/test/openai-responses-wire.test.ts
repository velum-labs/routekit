import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { normalizeOpenAiResponsesCallIds } from "../adapters/openai-responses-wire.js";

test("Responses call ids are normalized deterministically without mutating input", () => {
  const longCallId = `call_${"a".repeat(80)}`;
  const shortCallId = "s".repeat(64);
  const overlongBoundaryId = "l".repeat(65);
  const call = { type: "custom_call", call_id: longCallId, name: "shell" };
  const output = { type: "typed_call_output", call_id: longCallId, output: "done" };
  const body = {
    input: [
      call,
      output,
      { type: "function_call", call_id: shortCallId },
      { type: "function_call", call_id: overlongBoundaryId }
    ]
  };

  const normalized = normalizeOpenAiResponsesCallIds(body) as typeof body;
  const normalizedCallId = normalized.input[0]?.call_id;

  assert.match(normalizedCallId ?? "", /^rk_[A-Za-z0-9_-]+$/);
  assert.ok((normalizedCallId?.length ?? Infinity) <= 64);
  assert.equal(normalized.input[1]?.call_id, normalizedCallId);
  assert.equal(normalized.input[2]?.call_id, shortCallId);
  assert.equal(normalized.input[2]?.call_id.length, 64);
  assert.notEqual(normalized.input[3]?.call_id, overlongBoundaryId);
  assert.ok((normalized.input[3]?.call_id.length ?? Infinity) <= 64);
  assert.equal(body.input[0], call);
  assert.equal(body.input[1], output);
  assert.equal(call.call_id, longCallId);
  assert.equal(output.call_id, longCallId);
});

test("Responses call id normalization hashes the complete id and leaves malformed input untouched", () => {
  const prefix = "x".repeat(64);
  const malformed = [null, "text", 7, ["nested"], { call_id: 42 }];
  const body = {
    input: [
      { type: "function_call", call_id: `${prefix}a` },
      { type: "function_call", call_id: `${prefix}b` },
      ...malformed
    ]
  };

  const normalized = normalizeOpenAiResponsesCallIds(body) as {
    input: Array<Record<string, unknown> | unknown>;
  };
  const first = normalized.input[0] as { call_id: string };
  const second = normalized.input[1] as { call_id: string };
  assert.notEqual(first.call_id, second.call_id);
  assert.deepEqual(normalized.input.slice(2), malformed);
});


test("Responses call id normalization disambiguates a reserved generated ID", () => {
  const longCallId = `call_${"collision".repeat(12)}`;
  const preexistingCandidate = `rk_${createHash("sha256")
    .update(longCallId, "utf8")
    .digest("base64url")}`;
  const body = {
    input: [
      { type: "function_call_output", call_id: longCallId, output: "done" },
      { type: "function_call", call_id: preexistingCandidate, name: "reserved" },
      { type: "function_call", call_id: longCallId, name: "actual" }
    ]
  };

  const normalized = normalizeOpenAiResponsesCallIds(body) as typeof body;
  const longOutputId = normalized.input[0]?.call_id;
  const reservedId = normalized.input[1]?.call_id;
  const longCallIdReplacement = normalized.input[2]?.call_id;

  assert.equal(reservedId, preexistingCandidate);
  assert.notEqual(longOutputId, reservedId);
  assert.equal(longOutputId, longCallIdReplacement);
  assert.ok((longOutputId?.length ?? Infinity) <= 64);
  assert.equal(body.input[0]?.call_id, longCallId);
  assert.equal(body.input[2]?.call_id, longCallId);
});

test("Responses call id replacement assignment is independent of occurrence order", () => {
  const firstLongId = `call_${"a".repeat(80)}`;
  const secondLongId = `call_${"b".repeat(80)}`;
  const normalize = (ids: string[]) => {
    const normalized = normalizeOpenAiResponsesCallIds({
      input: ids.map((call_id) => ({ call_id }))
    }) as { input: Array<{ call_id: string }> };
    return new Map(ids.map((id, index) => [id, normalized.input[index]?.call_id]));
  };

  const forward = normalize([firstLongId, secondLongId]);
  const reversed = normalize([secondLongId, firstLongId]);
  assert.equal(forward.get(firstLongId), reversed.get(firstLongId));
  assert.equal(forward.get(secondLongId), reversed.get(secondLongId));
});
