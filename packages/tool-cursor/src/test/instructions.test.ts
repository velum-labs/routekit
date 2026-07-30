import assert from "node:assert/strict";
import { test } from "node:test";

import { cursorModelName } from "@velum-labs/routekit-contracts";
import type { ToolLaunchContext } from "@velum-labs/routekit-tools";

import { cursorByokBaseUrl, cursorInstructions, launchCursor } from "../launch.js";

test("cursorInstructions print the gateway's routekit/-namespaced spelling", () => {
  const model = "claude-code/claude-fable-5";
  const text = cursorInstructions("https://example.ts.net", model, "token");
  assert.match(text, /Override OpenAI Base URL : https:\/\/example\.ts\.net\/v1\/cursor/);
  assert.match(text, new RegExp(`Model name\\s+: ${cursorModelName(model)}`));
  assert.doesNotMatch(text, /claude-code-claude-fable-5/);
  assert.match(text, /namespaced under routekit\//);
});

test("cursorByokBaseUrl normalizes the gateway origin onto the /v1/cursor door", () => {
  assert.equal(cursorByokBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1/cursor");
  assert.equal(cursorByokBaseUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/v1/cursor");
  assert.equal(cursorByokBaseUrl("https://gateway.test/v1"), "https://gateway.test/v1/cursor");
});

function launchContext(
  spec: Partial<ToolLaunchContext["spec"]>,
  log: (line: string) => void
): ToolLaunchContext {
  return {
    spec: {
      gatewayUrl: "http://127.0.0.1:8080",
      defaultModel: "openai/gpt-5.5",
      models: [],
      args: [],
      ...spec
    },
    log,
    prepareForPassthrough: () => {
      throw new Error("cursor must not take over the terminal for a spawned tool");
    },
    registerPort: () => {
      throw new Error("cursor must not register a local bridge port");
    },
    unregisterPort: () => {},
    registerDisposer: () => {},
    publishResumeCursor: () => undefined
  };
}

test("launchCursor prints BYOK setup for the local gateway without spawning a bridge", async () => {
  const lines: string[] = [];
  assert.deepEqual(await launchCursor(launchContext({}, (line) => lines.push(line))), {
    exitCode: 0
  });
  assert.match(lines[0]!, /Override OpenAI Base URL : http:\/\/127\.0\.0\.1:8080\/v1\/cursor/);
  assert.match(lines[0]!, new RegExp(`Model name\\s+: ${cursorModelName("openai/gpt-5.5")}`));
  assert.match(lines[0]!, /OpenAI API Key\s+: routekit-local/);
});

test("launchCursor prefers a public gateway URL and the gateway token", async () => {
  const lines: string[] = [];
  await launchCursor(
    launchContext(
      { publicUrl: "https://gateway.ts.net", auth: { token: "gateway-token" } },
      (line) => lines.push(line)
    )
  );
  assert.match(lines[0]!, /Override OpenAI Base URL : https:\/\/gateway\.ts\.net\/v1\/cursor/);
  assert.match(lines[0]!, /OpenAI API Key\s+: gateway-token/);
});
