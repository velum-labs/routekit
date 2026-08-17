import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  normalizeOpenAiResponsesCallIds,
  parseResponsesEncryptedContent,
  prepareResponsesEncryptedInput,
  repairLegacyToolSearchItemIds,
  wrapResponsesEncryptedContent,
  wrapResponsesEncryptedResponse,
  type ResponsesEncryptedContentOwner
} from "../adapters/openai-responses-wire.js";

const OWNER_A: ResponsesEncryptedContentOwner = {
  provider: "codex",
  nativeModel: "gpt-5.6"
};
const OWNER_B: ResponsesEncryptedContentOwner = {
  provider: "openai",
  nativeModel: "gpt-5.6"
};

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

test("legacy tool-search item ids are repaired narrowly without mutating input", () => {
  const legacy = {
    type: "tool_search_call",
    id: "ttc_legacy",
    call_id: "call_search",
    status: "completed"
  };
  const valid = {
    type: "tool_search_call",
    id: "tsc_valid",
    call_id: "call_valid"
  };
  const unrelated = {
    type: "function_call",
    id: "ttc_function",
    call_id: "call_function"
  };
  const output = {
    type: "tool_search_output",
    call_id: "call_search",
    tools: []
  };
  const body = {
    model: "gpt-5.6-sol",
    input: [legacy, valid, unrelated, output]
  };

  const repaired = repairLegacyToolSearchItemIds(body) as typeof body;

  assert.notEqual(repaired, body);
  assert.notEqual(repaired.input, body.input);
  assert.deepEqual(repaired.input[0], {
    ...legacy,
    id: "tsc_legacy"
  });
  assert.equal(repaired.input[0]?.call_id, "call_search");
  assert.equal(repaired.input[1], valid);
  assert.equal(repaired.input[2], unrelated);
  assert.equal(repaired.input[3], output);
  assert.equal(legacy.id, "ttc_legacy");

  const alreadyCompatible = { input: [valid, output] };
  assert.equal(
    repairLegacyToolSearchItemIds(alreadyCompatible),
    alreadyCompatible
  );
  const stringInput = { input: "hello" };
  assert.equal(repairLegacyToolSearchItemIds(stringInput), stringInput);
});

test("encrypted Responses ownership round-trips exact opaque content", () => {
  const ciphertext = "opaque.with.separators/and unicode \u{1f9e0}\nbytes";
  const wrapped = wrapResponsesEncryptedContent(ciphertext, OWNER_A);
  assert.match(wrapped, /^rk1\.[A-Za-z0-9_-]+\./);
  assert.deepEqual(parseResponsesEncryptedContent(wrapped), {
    owner: OWNER_A,
    ciphertext
  });
  assert.equal(wrapResponsesEncryptedContent(wrapped, OWNER_B), wrapped);
});

test("encrypted input forward policy unwraps only the matching provider and native model", () => {
  const matching = wrapResponsesEncryptedContent("cipher-a", OWNER_A);
  const otherProvider = wrapResponsesEncryptedContent("cipher-b", OWNER_B);
  const otherModel = wrapResponsesEncryptedContent("cipher-c", {
    provider: OWNER_A.provider,
    nativeModel: "gpt-5.7"
  });
  const body = {
    input: [
      { role: "user", content: "continue" },
      { type: "reasoning", encrypted_content: matching },
      { type: "message", role: "assistant", content: "from A" },
      { type: "reasoning", encrypted_content: otherProvider },
      { type: "message", role: "assistant", content: "from B" },
      { type: "reasoning", encrypted_content: otherModel },
      { type: "reasoning", encrypted_content: "legacy-raw" },
      { type: "reasoning", summary: [] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" }
    ]
  };

  const prepared = prepareResponsesEncryptedInput(body, {
    mode: "forward",
    owner: OWNER_A
  });
  const input = (prepared.body as typeof body).input;
  assert.equal(prepared.dropped, 3);
  assert.deepEqual(
    input.map((item) => item.type ?? item.role),
    ["user", "reasoning", "message", "message", "reasoning", "function_call"]
  );
  assert.equal(input[1]?.encrypted_content, "cipher-a");
  assert.equal(input[4]?.encrypted_content, undefined);
  assert.equal(body.input[1]?.encrypted_content, matching, "caller input is not mutated");
});

test("encrypted input relay and drop policies retain the portable transcript", () => {
  const ownedA = wrapResponsesEncryptedContent("cipher-a", OWNER_A);
  const ownedB = wrapResponsesEncryptedContent("cipher-b", OWNER_B);
  const malformedHeader =
    `rk1.${ownedA.split(".")[1]}!.cipher-malformed`;
  const body = {
    input: [
      { type: "reasoning", encrypted_content: ownedA },
      { type: "message", role: "assistant", content: "A" },
      { type: "reasoning", encrypted_content: ownedB },
      { type: "message", role: "assistant", content: "B" },
      { type: "reasoning", encrypted_content: "rk2.future.payload" },
      { type: "reasoning", encrypted_content: "rk1.bad.payload" },
      { type: "reasoning", encrypted_content: malformedHeader },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" }
    ]
  };

  const relayed = prepareResponsesEncryptedInput(body, { mode: "relay" });
  assert.equal(relayed.dropped, 3);
  assert.deepEqual(
    (relayed.body as typeof body).input.map((item) => item.encrypted_content),
    [ownedA, undefined, ownedB, undefined, undefined]
  );

  const dropped = prepareResponsesEncryptedInput(body, { mode: "drop" });
  assert.equal(dropped.dropped, 5);
  assert.deepEqual(
    (dropped.body as typeof body).input.map((item) => item.type),
    ["message", "message", "function_call"]
  );
});

test("forward policy can retain a matching wrapper for a later provider bridge", () => {
  const wrapped = wrapResponsesEncryptedContent("cipher-a", OWNER_A);
  const body = {
    input: [{ type: "reasoning", encrypted_content: wrapped }]
  };
  const prepared = prepareResponsesEncryptedInput(body, {
    mode: "forward",
    owner: OWNER_A,
    unwrap: false
  });
  assert.equal(prepared.body, body);
  assert.equal(prepared.dropped, 0);
});

test("encrypted tool and message parts preserve portable history across provider switches", () => {
  const matching = wrapResponsesEncryptedContent("matching", OWNER_A);
  const foreign = wrapResponsesEncryptedContent("foreign", OWNER_B);
  const otherModel = wrapResponsesEncryptedContent("other-model", {
    provider: OWNER_A.provider,
    nativeModel: "gpt-5.7"
  });
  const message = {
    type: "agent_message",
    id: "amsg_1",
    content: [
      { type: "input_text", text: "visible handoff" },
      { type: "encrypted_content", encrypted_content: foreign }
    ]
  };
  const functionOutput = {
    type: "function_call_output",
    call_id: "call_1",
    output: [
      { type: "input_text", text: "visible result" },
      { type: "encrypted_content", encrypted_content: matching },
      { type: "encrypted_content", encrypted_content: foreign },
      { type: "encrypted_content", encrypted_content: "legacy-raw" }
    ]
  };
  const customOutput = {
    type: "custom_tool_call_output",
    call_id: "call_2",
    output: [
      { type: "encrypted_content", encrypted_content: otherModel }
    ]
  };
  const objectOutput = {
    type: "function_call_output",
    call_id: "call_3",
    output: {
      type: "encrypted_content",
      encrypted_content: matching
    }
  };
  const compaction = {
    type: "compaction",
    encrypted_content: foreign
  };
  const body = {
    input: [
      message,
      functionOutput,
      customOutput,
      objectOutput,
      compaction
    ]
  };

  const prepared = prepareResponsesEncryptedInput(body, {
    mode: "forward",
    owner: OWNER_A
  });
  const input = (prepared.body as {
    input: Array<Record<string, unknown>>;
  }).input;

  assert.equal(prepared.dropped, 5);
  assert.deepEqual(input, [
    {
      type: "agent_message",
      id: "amsg_1",
      content: [{ type: "input_text", text: "visible handoff" }]
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: "visible result" },
        { type: "encrypted_content", encrypted_content: "matching" }
      ]
    },
    {
      type: "custom_tool_call_output",
      call_id: "call_2",
      output: ""
    },
    {
      type: "function_call_output",
      call_id: "call_3",
      output: {
        type: "encrypted_content",
        encrypted_content: "matching"
      }
    }
  ]);
  assert.equal(
    (message.content[1] as { encrypted_content: string }).encrypted_content,
    foreign,
    "caller message is not mutated"
  );
  assert.equal(
    (functionOutput.output[1] as { encrypted_content: string })
      .encrypted_content,
    matching,
    "caller function output is not mutated"
  );
});

test("encrypted-only message carriers are removed while tool outputs retain pairing", () => {
  const foreign = wrapResponsesEncryptedContent("foreign", OWNER_B);
  const body = {
    input: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "encrypted_content", encrypted_content: foreign }
        ]
      },
      {
        type: "agent_message",
        id: "amsg_1",
        content: [
          { type: "encrypted_content", encrypted_content: "legacy-raw" }
        ]
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "encrypted_content", encrypted_content: foreign }
        ]
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_2",
        output: {
          type: "encrypted_content",
          encrypted_content: "legacy-raw"
        }
      }
    ]
  };

  const prepared = prepareResponsesEncryptedInput(body, {
    mode: "forward",
    owner: OWNER_A
  });
  assert.equal(prepared.dropped, 4);
  assert.deepEqual((prepared.body as typeof body).input, [
    { type: "function_call_output", call_id: "call_1", output: "" },
    { type: "custom_tool_call_output", call_id: "call_2", output: "" }
  ]);
});

test("relay policy retains owned nested content without unwrapping", () => {
  const owned = wrapResponsesEncryptedContent("owned", OWNER_A);
  const body = {
    input: [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "encrypted_content", encrypted_content: owned },
          { type: "encrypted_content", encrypted_content: "legacy-raw" }
        ]
      }
    ]
  };
  const prepared = prepareResponsesEncryptedInput(body, { mode: "relay" });
  assert.equal(prepared.dropped, 1);
  assert.deepEqual((prepared.body as typeof body).input, [
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [{ type: "encrypted_content", encrypted_content: owned }]
    }
  ]);
});

test("buffered Responses output wraps all supported encrypted replay content", async () => {
  const response = Response.json({
    id: "resp_1",
    output: [
      { type: "reasoning", encrypted_content: "cipher-a", summary: [] },
      { type: "compaction", encrypted_content: "compact-a" },
      {
        type: "agent_message",
        content: [
          { type: "input_text", text: "handoff" },
          { type: "encrypted_content", encrypted_content: "agent-a" }
        ]
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "result" },
          { type: "encrypted_content", encrypted_content: "function-a" }
        ]
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_2",
        output: {
          type: "encrypted_content",
          encrypted_content: "custom-a"
        }
      },
      { type: "message", content: [{ type: "output_text", text: "done" }] }
    ]
  }, {
    headers: { "content-length": "1", "x-test": "kept" }
  });
  const wrapped = await wrapResponsesEncryptedResponse(response, OWNER_A);
  const payload = await wrapped.json() as Record<string, unknown>;
  const encrypted = [...JSON.stringify(payload).matchAll(
    /"encrypted_content":"([^"]+)"/g
  )].map((match) => parseResponsesEncryptedContent(match[1]));
  assert.deepEqual(
    encrypted,
    ["cipher-a", "compact-a", "agent-a", "function-a", "custom-a"].map(
      (ciphertext) => ({ owner: OWNER_A, ciphertext })
    )
  );
  assert.equal(wrapped.headers.get("content-length"), null);
  assert.equal(wrapped.headers.get("x-test"), "kept");
});

test("streaming Responses output wraps encrypted replay content and preserves SSE framing", async () => {
  const encoder = new TextEncoder();
  const raw = [
    ": keepalive\r\n\r\n",
    "id: event-1\r\n",
    "retry: 1000\r\n",
    "event: response.output_item.done\r\n",
    'data: {"output_index":0,\r\n',
    'data: "item":{"type":"reasoning","encrypted_content":"cipher-\u{1f9e0}"}}\r\n\r\n',
    "event: response.output_item.done\r\n",
    'data: {"output_index":1,"item":{"type":"function_call_output","call_id":"call_1","output":[{"type":"encrypted_content","encrypted_content":"function-stream"}]}}\r\n\r\n',
    "event: response.completed\r\n",
    'data: {"response":{"output":[{"type":"agent_message","content":[{"type":"encrypted_content","encrypted_content":"terminal"}]}]}}\r\n\r\n',
    "event: custom\r\n",
    "data: not-json\r\n\r\n",
    "data: [DONE]\r\n\r\n"
  ].join("");
  const bytes = encoder.encode(raw);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 3) {
        controller.enqueue(bytes.slice(index, index + 3));
      }
      controller.close();
    }
  });
  const response = new Response(source, {
    headers: { "content-type": "text/event-stream", "content-length": "5" }
  });
  const wrapped = await wrapResponsesEncryptedResponse(response, OWNER_A);
  const text = await wrapped.text();

  assert.match(text, /^: keepalive\r\n\r\n/);
  assert.match(text, /id: event-1\r\nretry: 1000\r\nevent: response\.output_item\.done/);
  assert.match(text, /event: custom\r\ndata: not-json\r\n\r\n/);
  assert.match(text, /data: \[DONE\]\r\n\r\n$/);
  assert.equal(wrapped.headers.get("content-length"), null);

  const envelopes = [...text.matchAll(/"encrypted_content":"([^"]+)"/g)]
    .map((match) => parseResponsesEncryptedContent(match[1]));
  assert.deepEqual(envelopes, [
    { owner: OWNER_A, ciphertext: "cipher-\u{1f9e0}" },
    { owner: OWNER_A, ciphertext: "function-stream" },
    { owner: OWNER_A, ciphertext: "terminal" }
  ]);
});
