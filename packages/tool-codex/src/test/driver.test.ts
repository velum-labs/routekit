import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { HarnessEvent } from "@velum-labs/routekit-harness-core";
import { driverContractSuite } from "@velum-labs/routekit-harness-core/testing";

import { createCodexDriver } from "../driver.js";

/**
 * A fake `codex` CLI: honors `--version`, and for `exec --json`
 * reads the prompt from stdin and emits the JSONL event stream the codex-sdk
 * parses (thread.started, turn.started, item, turn.completed). `resume <id>`
 * reuses the given thread id so resume round-trips are observable.
 */
const FAKE_CODEX_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.145.0"); process.exit(0); }
const resumeIdx = args.indexOf("resume");
const threadId = resumeIdx >= 0 ? args[resumeIdx + 1] : "thread_fake_1";
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  emit({ type: "item.started", item: { id: "i1", type: "agent_message", text: "" } });
  emit({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "ARGS: " + args.join(" ") + "\\nCODEX_HOME: " + (process.env.CODEX_HOME || "") + "\\nOK: " + input.trim() } });
  emit({ type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } });
  process.exit(0);
});
`;

function fakeCodexRepo(): { command: string; cwd: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codex-driver-"));
  const command = join(dir, "codex-fake.mjs");
  writeFileSync(command, FAKE_CODEX_CLI);
  chmodSync(command, 0o755);
  return { command, cwd: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const repo = fakeCodexRepo();

driverContractSuite({
  name: "codex driver",
  createInstance: async () => {
    const driver = createCodexDriver();
    const config = driver.configSchema.parse({ command: repo.command });
    return driver.createInstance(config);
  },
  startOptions: () => ({ cwd: repo.cwd, model: "gpt-5.1-codex" }),
  supportsResume: true,
  turnTimeoutMs: 15_000
});

test("codex driver maps the CLI event stream into canonical events", async () => {
  const driver = createCodexDriver();
  const instance = await driver.createInstance(
    driver.configSchema.parse({ command: repo.command })
  );
  try {
    const session = await instance.startSession({ cwd: repo.cwd });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "hello codex" })) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    assert.ok(types.includes("session.started"));
    assert.ok(types.includes("turn.started"));
    const delta = events.find((event) => event.type === "content.delta");
    assert.ok(delta && delta.text.includes("hello codex"));
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(completed?.endReason, "completed");
    assert.equal(completed?.usage?.outputTokens, 2);
    // The real thread id from thread.started becomes the resume cursor.
    const cursor = session.resumeCursor();
    assert.equal((cursor?.data as { threadId?: string }).threadId, "thread_fake_1");
    // Every event carries the codex kind and the raw envelope is preserved.
    assert.ok(events.every((event) => event.kind === "codex"));
    assert.ok(events.some((event) => event.raw?.source === "codex.exec.json"));
  } finally {
    await instance.dispose();
    repo.cleanup();
  }
});

test("codex driver forwards effort as the SDK CLI config", async () => {
  const driver = createCodexDriver();
  const effortRepo = fakeCodexRepo();
  const instance = await driver.createInstance(
    driver.configSchema.parse({ command: effortRepo.command })
  );
  try {
    const session = await instance.startSession({
      cwd: effortRepo.cwd,
      reasoning: { mode: "effort", effort: "low" }
    });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "reason carefully" })) {
      events.push(event);
    }
    const text = events
      .flatMap((event) => (event.type === "content.delta" ? [event.text] : []))
      .join("");
    assert.match(text, /model_reasoning_effort="low"/);
  } finally {
    await instance.dispose();
    effortRepo.cleanup();
  }
});

test("codex driver releases the turn after reasoning validation fails", async () => {
  const driver = createCodexDriver();
  const validationRepo = fakeCodexRepo();
  const instance = await driver.createInstance(
    driver.configSchema.parse({ command: validationRepo.command })
  );
  try {
    const session = await instance.startSession({
      cwd: validationRepo.cwd,
      reasoning: { mode: "effort", effort: "low" }
    });
    await assert.rejects(async () => {
      for await (const _event of session.sendTurn({
        prompt: "invalid override",
        reasoning: { mode: "effort", effort: "high" }
      })) {
        // Drain.
      }
    }, /reasoning must be selected before the session starts/);

    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "valid retry" })) {
      events.push(event);
    }
    assert.equal(events.find((event) => event.type === "turn.completed")?.endReason, "completed");
  } finally {
    await instance.dispose();
    validationRepo.cleanup();
  }
});

test("gateway-routed codex homes are owned by their harness instance", async () => {
  const driver = createCodexDriver();
  const routedRepo = fakeCodexRepo();
  const userHome = mkdtempSync(join(tmpdir(), "codex-driver-user-"));
  const context = {
    env: { ...process.env, HOME: userHome, CODEX_HOME: undefined }
  };
  const config = driver.configSchema.parse({
    command: routedRepo.command,
    provider: { baseUrl: "http://127.0.0.1:8080/v1" }
  });
  const first = await driver.createInstance(config, context);
  const second = await driver.createInstance(config, context);
  let firstHome: string | undefined;
  let secondHome: string | undefined;
  try {
    const readHome = async (instance: typeof first): Promise<string> => {
      const session = await instance.startSession({ cwd: routedRepo.cwd });
      const events: HarnessEvent[] = [];
      for await (const event of session.sendTurn({ prompt: "show home" })) {
        events.push(event);
      }
      const text = events
        .flatMap((event) => (event.type === "content.delta" ? [event.text] : []))
        .join("");
      const match = /^CODEX_HOME: (.+)$/m.exec(text);
      assert.ok(match?.[1]);
      return match[1];
    };
    firstHome = await readHome(first);
    secondHome = await readHome(second);
    assert.notEqual(firstHome, secondHome);
    assert.ok(firstHome.startsWith(join(userHome, ".cache", "routekit", "codex")));
    assert.ok(secondHome.startsWith(join(userHome, ".cache", "routekit", "codex")));

    await first.dispose();
    assert.equal(existsSync(firstHome), false);
    assert.equal(existsSync(secondHome), true);
    await second.dispose();
    assert.equal(existsSync(secondHome), false);
  } finally {
    await Promise.allSettled([first.dispose(), second.dispose()]);
    routedRepo.cleanup();
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("codex driver probe reports version and installed state", async () => {
  const driver = createCodexDriver();
  const repo2 = fakeCodexRepo();
  try {
    const status = await driver.probe({ env: { ...process.env } as Record<string, string> });
    // The default command "codex" may or may not be installed on the host, so
    // this only asserts the shape; the fake-command instance path is covered above.
    assert.equal(status.kind, "codex");
    assert.ok(typeof status.installed === "boolean");
  } finally {
    repo2.cleanup();
  }
});
