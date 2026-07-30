import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startGateway } from "@velum-labs/routekit-gateway";
import type { Backend } from "@velum-labs/routekit-gateway";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const NATIVE_E2E_TOKEN = "native-session-e2e-token";

type CliResult = { status: number; stdout: string; stderr: string };
type TmuxPane = { name: string; close(): void; send(text: string): void; capture(): string };

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, [command === "tmux" ? "-V" : "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15_000
  });
  return result.error === undefined && result.status === 0;
}

const nativeSessionE2eSkip =
  process.platform !== "linux"
    ? "native session compatibility is enforced by the Linux CI job"
    : !commandAvailable("tmux")
      ? "tmux is required for the Codex interactive lifecycle test"
      : !commandAvailable("codex")
        ? "Codex CLI is not installed"
        : !commandAvailable("claude")
          ? "Claude Code CLI is not installed"
          : false;

function tmux(args: readonly string[]) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    timeout: 30_000
  });
}

function shellArgument(value: string): string {
  return JSON.stringify(value);
}

function createPane(input: { cwd: string; env: NodeJS.ProcessEnv; argv: readonly string[] }): TmuxPane {
  const name = `routekit-native-session-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const environment = Object.entries(input.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const started = tmux([
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "180",
    "-y",
    "50",
    "-c",
    input.cwd,
    ...environment,
    "--",
    "sleep",
    "300"
  ]);
  assert.equal(started.status, 0, started.stderr);
  const retained = tmux(["set-option", "-t", name, "remain-on-exit", "on"]);
  assert.equal(retained.status, 0, retained.stderr);
  // Use a shell command as one final argument so native flags such as
  // --no-alt-screen are never interpreted as tmux flags.
  const command = input.argv.map(shellArgument).join(" ");
  const launched = tmux(["respawn-pane", "-k", "-t", name, "/bin/sh", "-c", command]);
  assert.equal(launched.status, 0, launched.stderr);

  const capture = (): string => {
    const result = tmux(["capture-pane", "-p", "-e", "-S", "-", "-t", name]);
    return result.status === 0 ? result.stdout : `${result.stdout}\n${result.stderr}`;
  };
  return {
    name,
    capture,
    send(text: string): void {
      const buffer = `${name}-${Math.random().toString(16).slice(2)}`;
      const buffered = tmux(["set-buffer", "-b", buffer, text]);
      assert.equal(buffered.status, 0, buffered.stderr);
      const pasted = tmux(["paste-buffer", "-b", buffer, "-t", name, "-d"]);
      assert.equal(pasted.status, 0, pasted.stderr);
      const entered = tmux(["send-keys", "-t", name, "Enter"]);
      assert.equal(entered.status, 0, entered.stderr);
    },
    close(): void {
      tmux(["send-keys", "-t", name, "C-c"]);
      tmux(["send-keys", "-t", name, "C-c"]);
      tmux(["kill-session", "-t", name]);
    }
  };
}

async function eventually(
  predicate: () => boolean,
  timeoutMs: number,
  detail: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms\n${detail()}`);
}

async function runRoutekit(
  args: readonly string[],
  input: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
      cwd: input.cwd,
      env: input.env,
      encoding: "utf8",
      timeout: 60_000
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? ""
    };
  }
}

async function mustRunRoutekit(
  args: readonly string[],
  input: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<string> {
  const result = await runRoutekit(args, input);
  assert.equal(
    result.status,
    0,
    `routekit ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

function writeActiveRemote(state: string, gatewayUrl: string): void {
  mkdirSync(join(state, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(state, "remotes.json"),
    `${JSON.stringify({
      version: 1,
      active: "native-test",
      remotes: [
        {
          name: "native-test",
          gatewayUrl,
          sshHost: "native-test",
          addedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    })}\n`,
    { mode: 0o600 }
  );
  writeFileSync(join(state, "secrets", "remote-native-test"), `${NATIVE_E2E_TOKEN}\n`, {
    mode: 0o600
  });
}

function backendFor(model: string, calls: Array<{ model?: string }>): Backend {
  return {
    defaultModel: model,
    resolveModel: (requested) => requested ?? model,
    models: async () =>
      Response.json({ object: "list", data: [{ id: model, object: "model" }] }),
    chat: async (body) => {
      const request = body as { model?: unknown };
      calls.push({ ...(typeof request.model === "string" ? { model: request.model } : {}) });
      return Response.json({
        id: "chatcmpl-native-session",
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ROUTEKIT_NATIVE_SESSION_OK" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    },
    embeddings: async () => Response.json({ object: "list", data: [] })
  };
}

function routekitEnvironment(input: {
  home: string;
  state: string;
  codexHome?: string;
  claudeConfigDir?: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: input.home,
    ROUTEKIT_HOME: input.state,
    ROUTEKIT_TELEMETRY: "0",
    ROUTEKIT_NO_TUI: "1",
    NO_COLOR: "1",
    ...(input.codexHome !== undefined ? { CODEX_HOME: input.codexHome } : {}),
    ...(input.claudeConfigDir !== undefined ? { CLAUDE_CONFIG_DIR: input.claudeConfigDir } : {})
  };
}

test(
  "real Codex captures an exact native thread in the standard home and deletes it through the native CLI",
  { skip: nativeSessionE2eSkip },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "routekit-native-codex-"));
    const home = join(root, "home");
    const codexHome = join(home, ".codex");
    const state = join(root, "state");
    const project = join(root, "project");
    const calls: Array<{ model?: string }> = [];
    const model = "gpt-5.5";
    const gateway = await startGateway({
      backend: backendFor(model, calls),
      authToken: NATIVE_E2E_TOKEN
    });
    t.after(async () => {
      await gateway.close();
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(project, { recursive: true, mode: 0o700 });
    // This is a regular user-owned Codex config for the direct native resume
    // proof. RouteKit must not create or scan its session store.
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        `model = ${JSON.stringify(model)}`,
        'model_provider = "native-test"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "",
        "[model_providers.native-test]",
        'name = "Native test gateway"',
        `base_url = ${JSON.stringify(`${gateway.url()}/v1`)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        'env_key = "ROUTEKIT_GATEWAY_TOKEN"',
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    writeActiveRemote(state, gateway.url());
    const env = routekitEnvironment({ home, state, codexHome });
    const input = { cwd: project, env };
    const registryPath = join(state, "sessions", "registry.json");
    const pane = createPane({
      cwd: project,
      env,
      argv: [
        process.execPath,
        CLI_ENTRY,
        "codex",
        model,
        "--",
        "--no-alt-screen",
        "--dangerously-bypass-approvals-and-sandbox"
      ]
    });
    try {
      // Give the app-server/TUI pair time to initialize before submitting the
      // first interactive turn. The registry is deliberately unavailable until
      // that turn emits a supported thread/started notification.
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      pane.send("Reply with exactly ROUTEKIT_NATIVE_SESSION_OK");
      await eventually(
        () => existsSync(registryPath) && calls.length > 0,
        60_000,
        () => pane.capture()
      );
    } finally {
      pane.close();
    }

    const listed = JSON.parse(
      await mustRunRoutekit(["sessions", "list", "--json"], input)
    ) as {
      sessions: Array<{
        id: string;
        tool: string;
        target: unknown;
        resume: { data: { threadId: string } };
      }>;
    };
    assert.equal(listed.sessions.length, 1);
    const session = listed.sessions[0]!;
    assert.equal(session.tool, "codex");
    assert.deepEqual(session.target, { kind: "remote", name: "native-test" });
    assert.match(session.resume.data.threadId, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(readFileSync(registryPath, "utf8"), new RegExp(NATIVE_E2E_TOKEN));

    const callsBeforeNativeResume = calls.length;
    const nativePane = createPane({
      cwd: project,
      env: { ...env, ROUTEKIT_GATEWAY_TOKEN: NATIVE_E2E_TOKEN },
      argv: [
        "codex",
        "resume",
        session.resume.data.threadId,
        "--no-alt-screen",
        "--dangerously-bypass-approvals-and-sandbox"
      ]
    });
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      nativePane.send("Reply with exactly ROUTEKIT_NATIVE_SESSION_OK");
      await eventually(
        () => calls.length > callsBeforeNativeResume,
        60_000,
        () => nativePane.capture()
      );
    } finally {
      nativePane.close();
    }

    const removed = JSON.parse(
      await mustRunRoutekit(["--yes", "sessions", "rm", session.id, "--json"], input)
    ) as { removed: boolean; nativeSessionRemoved: boolean };
    assert.deepEqual(removed, { removed: true, nativeSessionRemoved: true });
    assert.deepEqual(
      JSON.parse(await mustRunRoutekit(["sessions", "list", "--json"], input)),
      { sessions: [] }
    );

    // This is an API-level deletion proof: do not inspect Codex's session
    // files. A direct native resume must reject the exact deleted UUID.
    const deletedPane = createPane({
      cwd: project,
      env: { ...env, ROUTEKIT_GATEWAY_TOKEN: NATIVE_E2E_TOKEN },
      argv: [
        "codex",
        "resume",
        session.resume.data.threadId,
        "--no-alt-screen",
        "--dangerously-bypass-approvals-and-sandbox"
      ]
    });
    try {
      await eventually(
        () => {
          const pane = tmux(["display-message", "-p", "-t", deletedPane.name, "#{pane_dead}"]);
          return pane.status === 0 && pane.stdout.trim() === "1";
        },
        30_000,
        () => deletedPane.capture()
      );
      assert.match(
        deletedPane.capture(),
        /no saved session found|not found|does not exist|unknown|missing/i
      );
    } finally {
      deletedPane.close();
    }
  }
);

test(
  "real Claude sessions use the standard store, exact native resume, and RouteKit forget semantics",
  { skip: nativeSessionE2eSkip },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "routekit-native-claude-"));
    const home = join(root, "home");
    const claudeConfigDir = join(home, ".claude");
    const state = join(root, "state");
    const project = join(root, "project");
    const calls: Array<{ model?: string }> = [];
    const model = "claude-native-test";
    const gateway = await startGateway({
      backend: backendFor(model, calls),
      authToken: NATIVE_E2E_TOKEN
    });
    t.after(async () => {
      await gateway.close();
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(claudeConfigDir, ".claude.json"),
      `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`,
      { mode: 0o600 }
    );
    writeActiveRemote(state, gateway.url());
    const env = routekitEnvironment({ home, state, claudeConfigDir });
    const input = { cwd: project, env };
    await mustRunRoutekit(
      [
        "claude",
        model,
        "--",
        "-p",
        "Reply with exactly ROUTEKIT_NATIVE_SESSION_OK",
        "--output-format",
        "text",
        "--dangerously-skip-permissions"
      ],
      input
    );
    assert.ok(calls.length > 0, "RouteKit launch made no gateway request");
    const listed = JSON.parse(
      await mustRunRoutekit(["sessions", "list", "--json"], input)
    ) as {
      sessions: Array<{
        id: string;
        tool: string;
        resume: { data: { sessionId: string } };
      }>;
    };
    assert.equal(listed.sessions.length, 1);
    const session = listed.sessions[0]!;
    assert.equal(session.tool, "claude");
    assert.match(session.resume.data.sessionId, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(
      readFileSync(join(state, "sessions", "registry.json"), "utf8"),
      new RegExp(NATIVE_E2E_TOKEN)
    );

    const beforeNativeResume = calls.length;
    const native = await execFileAsync(
      "claude",
      [
        "--resume",
        session.resume.data.sessionId,
        "-p",
        "Reply with exactly ROUTEKIT_NATIVE_SESSION_OK",
        "--output-format",
        "text",
        "--dangerously-skip-permissions"
      ],
      {
        cwd: project,
        env: {
          ...env,
          ANTHROPIC_BASE_URL: gateway.url(),
          ANTHROPIC_AUTH_TOKEN: NATIVE_E2E_TOKEN,
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
        },
        encoding: "utf8",
        timeout: 60_000
      }
    );
    assert.match(native.stdout, /ROUTEKIT_NATIVE_SESSION_OK/);
    assert.ok(calls.length > beforeNativeResume, "native Claude resume made no gateway request");

    const removed = JSON.parse(
      await mustRunRoutekit(["--yes", "sessions", "rm", session.id, "--json"], input)
    ) as { removed: boolean; nativeSessionRemoved: boolean };
    assert.deepEqual(removed, { removed: true, nativeSessionRemoved: false });
    assert.deepEqual(
      JSON.parse(await mustRunRoutekit(["sessions", "list", "--json"], input)),
      { sessions: [] }
    );

    const retained = await execFileAsync(
      "claude",
      [
        "--resume",
        session.resume.data.sessionId,
        "-p",
        "Reply with exactly ROUTEKIT_NATIVE_SESSION_OK",
        "--output-format",
        "text",
        "--dangerously-skip-permissions"
      ],
      {
        cwd: project,
        env: {
          ...env,
          ANTHROPIC_BASE_URL: gateway.url(),
          ANTHROPIC_AUTH_TOKEN: NATIVE_E2E_TOKEN,
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
        },
        encoding: "utf8",
        timeout: 60_000
      }
    );
    assert.match(retained.stdout, /ROUTEKIT_NATIVE_SESSION_OK/);
  }
);
