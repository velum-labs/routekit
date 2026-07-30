import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ResumeCursor } from "@velum-labs/routekit-harness-core";
import type { AgentProfile, ToolLaunchContext } from "@velum-labs/routekit-tools";

import {
  claudeAgentsJson,
  claudeEnv,
  claudeLaunchArgs,
  launchClaude,
  prepareClaudeLaunch
} from "../launch.js";

const PROFILES: readonly AgentProfile[] = [
  {
    id: "reviewer",
    model: "opaque-model",
    description: "Review changes.",
    instructions: "Return findings."
  }
];

function context(
  args: readonly string[],
  profiles = PROFILES,
  defaultModel = "opaque-model"
): ToolLaunchContext {
  return {
    spec: {
      gatewayUrl: "http://127.0.0.1",
      defaultModel,
      models: [{ id: defaultModel }],
      agentProfiles: profiles,
      args
    },
    log: () => undefined,
    prepareForPassthrough: () => undefined,
    registerPort: (_name, port) => `http://127.0.0.1:${port}`,
    unregisterPort: () => undefined,
    registerDisposer: () => undefined,
    publishResumeCursor: () => undefined
  };
}

test("claudeAgentsJson serializes generic profiles", () => {
  assert.deepEqual(JSON.parse(claudeAgentsJson(PROFILES)), {
    reviewer: {
      description: "Review changes.",
      prompt: "Return findings.",
      model: "claude-opaque-model"
    }
  });
});

test("Claude launcher projects claude-code models to native picker ids", () => {
  assert.deepEqual(claudeLaunchArgs(context([], [], "claude-code/claude-sonnet-4-6")), [
    "--model",
    "claude-sonnet-4-6"
  ]);
  assert.deepEqual(
    JSON.parse(
      claudeAgentsJson([
        {
          id: "native",
          model: "claude-code/claude-opus-4-8",
          description: "Use the subscription pool.",
          instructions: "Review."
        },
        {
          id: "cross",
          model: "codex/gpt-5.5",
          description: "Use Codex.",
          instructions: "Review."
        }
      ])
    ),
    {
      native: {
        description: "Use the subscription pool.",
        prompt: "Review.",
        model: "claude-opus-4-8"
      },
      cross: {
        description: "Use Codex.",
        prompt: "Review.",
        model: "claude-codex/gpt-5.5"
      }
    }
  );
});

test("Claude launcher forwards an explicit isolated config directory", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/tmp/routekit-claude-config";
  try {
    assert.equal(
      claudeEnv("http://127.0.0.1:8080").CLAUDE_CONFIG_DIR,
      "/tmp/routekit-claude-config"
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("claudeLaunchArgs adds profiles unless the user supplied agents", () => {
  const args = claudeLaunchArgs(context(["--verbose"]));
  assert.deepEqual(args.slice(0, 4), ["--model", "claude-opaque-model", "--verbose", "--agents"]);
  assert.deepEqual(claudeLaunchArgs(context(["--agents={}"])), [
    "--model",
    "claude-opaque-model",
    "--agents={}"
  ]);
  assert.deepEqual(claudeLaunchArgs(context([], [])), ["--model", "claude-opaque-model"]);
  assert.deepEqual(claudeLaunchArgs(context(["--model", "claude-user-selected"], [])), [
    "--model",
    "claude-user-selected"
  ]);
});

test("Claude launcher projects validated effort onto the picker model id", () => {
  const withEffort: ToolLaunchContext = {
    ...context([], [], "claude-code/claude-sonnet-4-6"),
    spec: {
      ...context([], [], "claude-code/claude-sonnet-4-6").spec,
      reasoning: { mode: "effort", effort: "high" }
    }
  };
  assert.deepEqual(claudeLaunchArgs(withEffort), ["--model", "claude-sonnet-4-6:high"]);

  const crossProvider: ToolLaunchContext = {
    ...context([], [], "codex/gpt-5.5"),
    spec: {
      ...context([], [], "codex/gpt-5.5").spec,
      reasoning: { mode: "effort", effort: "deep" }
    }
  };
  assert.deepEqual(claudeLaunchArgs(crossProvider), ["--model", "claude-codex/gpt-5.5:deep"]);

  assert.deepEqual(
    claudeLaunchArgs({
      ...withEffort,
      spec: {
        ...withEffort.spec,
        args: ["--model", "claude-user-selected"]
      }
    }),
    ["--model", "claude-user-selected"]
  );
});

const CLAUDE_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CLAUDE_CURSOR: ResumeCursor = {
  version: 1,
  kind: "claude_code",
  data: { sessionId: CLAUDE_SESSION_ID }
};

function withSession(
  session: ToolLaunchContext["spec"]["session"],
  args: readonly string[] = []
): ToolLaunchContext {
  const base = context(args, [], "claude-code/claude-sonnet-4-6");
  return { ...base, spec: { ...base.spec, session } };
}

test("managed Claude launches preassign and publish a native UUID", async () => {
  let published: ResumeCursor | undefined;
  const ctx = {
    ...withSession({ mode: "new" }),
    publishResumeCursor: (cursor: ResumeCursor) => {
      published = cursor;
    }
  };
  const prepared = await prepareClaudeLaunch(ctx);
  const sessionFlag = prepared.args.indexOf("--session-id");
  assert.notEqual(sessionFlag, -1);
  const sessionId = prepared.args[sessionFlag + 1];
  assert.match(sessionId ?? "", /^[0-9a-f-]{36}$/i);
  assert.deepEqual(published, {
    version: 1,
    kind: "claude_code",
    data: { sessionId }
  });
  assert.deepEqual(prepared.resumeCursor, published);
});

test("managed Claude launch waits for cursor publication before native spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routekit-claude-publication-"));
  const executable = join(dir, "claude");
  const marker = join(dir, "spawned");
  const originalPath = process.env.PATH;
  let resolvePublication: (() => void) | undefined;
  const publication = new Promise<void>((resolve) => {
    resolvePublication = resolve;
  });
  writeFileSync(executable, `#!/bin/sh\nprintf spawned > '${marker}'\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${dir}:${originalPath ?? ""}`;

  try {
    const launched = launchClaude({
      ...withSession({ mode: "new" }),
      publishResumeCursor: async () => await publication
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(existsSync(marker), false);

    resolvePublication?.();
    const result = await launched;
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(marker), true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed Claude resume validates and reapplies the stored model", () => {
  const args = claudeLaunchArgs(withSession({ mode: "resume", cursor: CLAUDE_CURSOR }));
  assert.deepEqual(args, ["--model", "claude-sonnet-4-6", "--resume", CLAUDE_SESSION_ID]);
  assert.throws(
    () =>
      claudeLaunchArgs(
        withSession({
          mode: "resume",
          cursor: { ...CLAUDE_CURSOR, kind: "codex" }
        })
      ),
    /compatible claude_code cursor/
  );
  assert.throws(
    () =>
      claudeLaunchArgs(
        withSession({
          mode: "resume",
          cursor: { ...CLAUDE_CURSOR, data: { sessionId: "not-a-uuid" } }
        })
      ),
    /invalid session id/
  );
});

test("managed Claude sessions reject native session flags", () => {
  for (const args of [
    ["--session-id", CLAUDE_SESSION_ID],
    [`--session-id=${CLAUDE_SESSION_ID}`],
    ["--resume", CLAUDE_SESSION_ID],
    [`--resume=${CLAUDE_SESSION_ID}`],
    ["--continue"]
  ]) {
    assert.throws(
      () => claudeLaunchArgs(withSession({ mode: "new" }, args)),
      /RouteKit is managing the Claude session/
    );
  }
});

test("ordinary Claude launches keep forwarded native session flags", () => {
  assert.deepEqual(claudeLaunchArgs(context(["--continue"], [])), [
    "--model",
    "claude-opaque-model",
    "--continue"
  ]);
});
