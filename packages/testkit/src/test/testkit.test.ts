import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { asBehavior, simErrors } from "../behaviors.js";
import { DOOR_PROFILES } from "../doors.js";
import type { ProviderSimHandle } from "../provider-sim.js";
import { startProviderSim } from "../provider-sim.js";
import { parseSse, sseText } from "../sse.js";

describe("routekit-testkit", () => {
  const simulators: ProviderSimHandle[] = [];

  afterEach(async () => {
    await Promise.all(simulators.splice(0).map((simulator) => simulator.close()));
  });

  it("exposes door profiles", () => {
    assert.ok(DOOR_PROFILES.length >= 3);
    assert.ok(DOOR_PROFILES.some((d) => d.id === "openai-chat"));
  });

  it("normalizes string behaviors", () => {
    assert.deepEqual(asBehavior("hi"), { reply: "hi" });
    assert.equal(simErrors.rateLimited().status, 429);
  });

  it("parses SSE text frames", () => {
    const frames = parseSse('data: {"choices":[{"delta":{"content":"ab"}}]}\n\ndata: [DONE]\n\n');
    assert.ok(frames.length >= 1);
    assert.equal(typeof sseText(frames), "string");
  });

  it("serves queued OpenAI replies and journals the real request", async () => {
    const simulator = await startProviderSim();
    simulators.push(simulator);
    await simulator.queue("sim-openai", ["hello from RouteKit"]);

    const response = await fetch(`${simulator.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sim-openai", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.choices[0]?.message.content, "hello from RouteKit");
    const calls = await simulator.calls({ model: "sim-openai" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.dialect, "openai-chat");
    assert.equal(calls[0]?.request.messages instanceof Array, true);
  });

  it("renders reasoning, tools, errors, and byte-split SSE", async () => {
    const simulator = await startProviderSim();
    simulators.push(simulator);
    await simulator.queue("sim-anthropic", [
      {
        reply: "done",
        reasoning: "think first",
        tool_calls: [{ id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
        chunk_bytes: 2
      },
      { error: simErrors.rateLimited(3) }
    ]);

    const streamed = await fetch(`${simulator.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sim-anthropic",
        stream: true,
        messages: [{ role: "user", content: "inspect" }],
        tools: [{ name: "read_file" }]
      })
    });
    const text = await streamed.text();
    assert.equal(streamed.status, 200);
    assert.match(text, /thinking_delta/);
    assert.match(text, /tool_use/);

    const failed = await fetch(`${simulator.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sim-anthropic",
        messages: [{ role: "user", content: "again" }]
      })
    });
    assert.equal(failed.status, 429);
    assert.equal(failed.headers.get("retry-after"), "3");
  });

  it("supports Responses and Google streaming dialects", async () => {
    const simulator = await startProviderSim();
    simulators.push(simulator);
    await simulator.queue("sim-responses", [{ reply: "response ok", reasoning: "because" }]);
    await simulator.queue("sim-google", [{ reply: "google ok", reasoning: "thought" }]);

    const responses = await fetch(`${simulator.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sim-responses", input: "hello", stream: true })
    });
    assert.match(await responses.text(), /response\.completed/);

    const google = await fetch(
      `${simulator.url}/v1beta/models/sim-google:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] })
      }
    );
    const googleText = await google.text();
    assert.match(googleText, /google /);
    assert.match(googleText, /"text":"ok"/);
    assert.match(googleText, /thought/);
  });
});
