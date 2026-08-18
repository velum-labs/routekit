import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type NativeCredentialLocation, nativeCredentialLocation } from "../native-credentials.js";

const execFileAsync = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

async function assertCredentialStored(
  tool: "codex" | "claude",
  configPath: string,
  routekitHome: string,
  expectedToken: string
): Promise<NativeCredentialLocation> {
  const location = nativeCredentialLocation(tool, configPath, routekitHome);
  // Linux is RouteKit's portable-file backend. macOS backend selection is
  // exercised separately with the runner's real login Keychain because this
  // lifecycle test intentionally replaces HOME to isolate client settings.
  if (process.platform === "darwin") return location;
  assert.equal(existsSync(location.fallbackPath), true);
  assert.equal(
    readFileSync(location.fallbackPath, "utf8").trim() === expectedToken,
    true,
    "the private credential file must contain the issued native-client credential"
  );
  assert.equal(statSync(location.fallbackPath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(location.fallbackPath)).mode & 0o777, 0o700);
  return location;
}

async function assertCredentialRemoved(location: NativeCredentialLocation): Promise<void> {
  assert.equal(existsSync(location.fallbackPath), false);
}

async function run(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 90_000
  });
}

async function runNative(
  binary: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, [...args], {
      cwd,
      env,
      // Codex reads stdin after receiving a prompt.  An inherited or open pipe
      // makes it wait forever in non-interactive CI, so close it explicitly.
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      rejectRun(
        new Error(
          `${binary} exited with ${code === null ? String(signal) : `code ${code}`}: ${stderr}`
        )
      );
    });
  });
}

test("native installs issue scoped tokens without persisting plaintext and revoke them on uninstall", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "routekit-native-install-e2e-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const project = join(root, "project");
  const codexHome = join(home, ".codex");
  const claudeConfig = join(home, ".claude");
  const upstreamRequests: string[] = [];
  const upstreamModels: string[] = [];
  const upstreamChatBodies: Array<{ model?: unknown; reasoning_effort?: unknown }> = [];
  const upstream = createServer(async (request, response) => {
    upstreamRequests.push(request.url ?? "");
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "mock-model" }, { id: "mock-secondary" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      stream?: unknown;
      model?: unknown;
      reasoning_effort?: unknown;
    };
    if (typeof body.model === "string") upstreamModels.push(body.model);
    if (request.url === "/v1/chat/completions") upstreamChatBodies.push(body);
    if (request.url === "/v1/responses") {
      const completed = {
        id: "resp-native-install",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "mock-model",
        output: [
          {
            type: "message",
            id: "msg-native-install",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "ROUTEKIT_NATIVE_CODEX_OK",
                annotations: []
              }
            ]
          }
        ],
        usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 }
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      let sequence = 0;
      const emit = (type: string, data: Record<string, unknown>) => {
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`
        );
      };
      emit("response.created", {
        response: { ...completed, status: "in_progress", output: [], usage: null }
      });
      emit("response.output_item.added", {
        output_index: 0,
        item: {
          type: "message",
          id: "msg-native-install",
          status: "in_progress",
          role: "assistant",
          content: []
        }
      });
      emit("response.content_part.added", {
        item_id: "msg-native-install",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
      emit("response.output_text.delta", {
        item_id: "msg-native-install",
        output_index: 0,
        content_index: 0,
        delta: "ROUTEKIT_NATIVE_CODEX_OK"
      });
      emit("response.output_text.done", {
        item_id: "msg-native-install",
        output_index: 0,
        content_index: 0,
        text: "ROUTEKIT_NATIVE_CODEX_OK"
      });
      emit("response.content_part.done", {
        item_id: "msg-native-install",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "ROUTEKIT_NATIVE_CODEX_OK", annotations: [] }
      });
      emit("response.output_item.done", { output_index: 0, item: completed.output[0] });
      emit("response.completed", { response: completed });
      response.end();
      return;
    }
    const completion = {
      id: "chatcmpl-native-install",
      object: "chat.completion",
      created: 0,
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ROUTEKIT_NATIVE_INSTALL_OK" },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    };
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          ...completion,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "ROUTEKIT_NATIVE_CLAUDE_OK" },
              finish_reason: null
            }
          ]
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          ...completion,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(completion));
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  const port = (upstream.address() as AddressInfo).port;
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: state,
    ROUTEKIT_NO_SUPERVISOR: "1",
    ROUTEKIT_DAEMON_PORT: "0",
    ROUTEKIT_TELEMETRY: "0",
    OPENAI_API_KEY: "native-install-test",
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    NO_COLOR: "1"
  };
  let daemonStarted = false;
  t.after(async () => {
    if (daemonStarted) await run(["stop"], project, env).catch(() => undefined);
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  });

  mkdirSync(join(home, ".config", "routekit"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(home, ".config", "routekit", "router.yaml"),
    [
      "providers:",
      "  openai: {}",
      "defaultModel: openai/mock-model",
      "reasoningCapabilities:",
      "  openai/mock-model:",
      "    efforts:",
      "      - id: high",
      "    wireShape: openai-chat",
      ""
    ].join("\n")
  );

  const codexInstalled = JSON.parse(
    (await run(["codex", "install", "--codex-home", codexHome, "--json"], project, env)).stdout
  ) as { credential?: string; tokenRotated?: boolean; configPath?: string };
  daemonStarted = true;
  assert.equal(codexInstalled.credential, "managed");
  assert.equal(codexInstalled.tokenRotated, true);
  const codexConfigPath = codexInstalled.configPath!;
  const codexToken = (
    await run(
      [
        "credential",
        "get",
        "--tool",
        "codex",
        "--config-path",
        codexConfigPath,
        "--routekit-home",
        state
      ],
      project,
      env
    )
  ).stdout.trim();
  const codexCredentialLocation = await assertCredentialStored(
    "codex",
    codexConfigPath,
    state,
    codexToken
  );
  const codexConfig = readFileSync(codexConfigPath, "utf8");
  assert.match(codexConfig, /\[model_providers\.routekit\.auth\]/);
  assert.match(codexConfig, /"credential", "get", "--tool", "codex"/);
  assert.doesNotMatch(codexConfig, /env_key = "ROUTEKIT_GATEWAY_TOKEN"/);
  assert.equal(codexConfig.includes(codexToken), false);
  assert.equal(
    /^model\s*=/m.test(codexConfig),
    false,
    "install must not set Codex's default model"
  );
  const codexProfilePath = join(codexHome, "routekit.config.toml");
  assert.equal(existsSync(codexProfilePath), true);
  assert.equal(existsSync(join(codexHome, "routekit-model-1.config.toml")), false);
  assert.match(readFileSync(codexProfilePath, "utf8"), /model = "openai\/mock-model"/);
  assert.match(readFileSync(codexProfilePath, "utf8"), /model_catalog_json/);
  const codexCatalog = JSON.parse(
    readFileSync(join(codexHome, ".routekit-model-catalog.json"), "utf8")
  ) as { models: Array<{ slug: string }> };
  assert.deepEqual(
    codexCatalog.models.map((model) => model.slug),
    ["openai/mock-model", "openai/mock-secondary"]
  );

  const daemon = JSON.parse((await run(["status", "--json"], project, env)).stdout) as {
    daemon?: { dataUrl?: string };
  };
  const dataUrl = daemon.daemon?.dataUrl;
  assert.equal(typeof dataUrl, "string");
  const gatewayResponse = await fetch(`${dataUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${codexToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/mock-model",
      messages: [{ role: "user", content: "hello" }]
    })
  });
  assert.equal(gatewayResponse.status, 200);
  await gatewayResponse.text();
  assert.ok(upstreamRequests.includes("/v1/chat/completions"));

  if (process.env.ROUTEKIT_NATIVE_CLIENT_E2E === "1") {
    const codex = await runNative(
      "codex",
      [
        "exec",
        "--profile",
        "routekit",
        "--model",
        "openai/mock-secondary",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        "Reply with ROUTEKIT_NATIVE_CODEX_OK and nothing else."
      ],
      project,
      { ...env, CODEX_HOME: codexHome, ROUTEKIT_GATEWAY_TOKEN: undefined }
    );
    assert.match(codex.stdout, /ROUTEKIT_NATIVE_CODEX_OK/);
    assert.doesNotMatch(codex.stderr, /Model metadata .* not found/i);
    assert.ok(upstreamRequests.includes("/v1/responses"));
    assert.ok(upstreamModels.includes("mock-secondary"));
  }

  const codexUpdated = JSON.parse(
    (await run(["codex", "install", "--codex-home", codexHome, "--json"], project, env)).stdout
  ) as { tokenRotated?: boolean };
  assert.equal(
    codexUpdated.tokenRotated,
    undefined,
    "same-target reinstall must not reissue a token"
  );

  const codexRotated = JSON.parse(
    (
      await run(
        ["codex", "install", "--codex-home", codexHome, "--rotate-token", "--json"],
        project,
        env
      )
    ).stdout
  ) as { tokenRotated?: boolean };
  assert.equal(codexRotated.tokenRotated, true);
  const codexRotatedToken = (
    await run(
      [
        "credential",
        "get",
        "--tool",
        "codex",
        "--config-path",
        codexConfigPath,
        "--routekit-home",
        state
      ],
      project,
      env
    )
  ).stdout.trim();
  assert.notEqual(codexRotatedToken, codexToken);

  const claudeInstalled = JSON.parse(
    (await run(["claude", "install", "--claude-config-dir", claudeConfig, "--json"], project, env))
      .stdout
  ) as { credential?: string; tokenRotated?: boolean; configPath?: string };
  assert.equal(claudeInstalled.credential, "managed");
  assert.equal(claudeInstalled.tokenRotated, true);
  const claudeToken = (
    await run(
      [
        "credential",
        "get",
        "--tool",
        "claude",
        "--config-path",
        claudeInstalled.configPath!,
        "--routekit-home",
        state
      ],
      project,
      env
    )
  ).stdout.trim();
  const claudeCredentialLocation = await assertCredentialStored(
    "claude",
    claudeInstalled.configPath!,
    state,
    claudeToken
  );
  const claudeSettings = readFileSync(claudeInstalled.configPath!, "utf8");
  assert.equal(claudeSettings.includes(claudeToken), false);
  assert.equal(claudeSettings.includes("ANTHROPIC_AUTH_TOKEN"), false);
  const parsedClaudeSettings = JSON.parse(claudeSettings) as {
    env: Record<string, string>;
    apiKeyHelper: string;
    availableModels: string[];
    enforceAvailableModels: boolean;
  };
  assert.match(parsedClaudeSettings.apiKeyHelper, /credential get/);
  assert.match(parsedClaudeSettings.apiKeyHelper, /--tool claude/);
  assert.equal(parsedClaudeSettings.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, "1");
  assert.equal(parsedClaudeSettings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
  assert.deepEqual(parsedClaudeSettings.availableModels, [
    "anthropic.routekit.openai/mock-model",
    "anthropic.routekit.openai/mock-secondary"
  ]);
  assert.equal(parsedClaudeSettings.enforceAvailableModels, true);
  const claudePicker = await fetch(`${dataUrl}/v1/models`, {
    headers: {
      authorization: `Bearer ${claudeToken}`,
      "anthropic-version": "2023-06-01"
    }
  });
  assert.equal(claudePicker.status, 200);
  const claudePickerModels = (await claudePicker.json()) as {
    data: Array<{ id: string; display_name: string }>;
  };
  assert.deepEqual(
    claudePickerModels.data.map((model) => ({ id: model.id, display_name: model.display_name })),
    [
      {
        id: "openai/mock-model",
        display_name: "openai/mock-model"
      },
      {
        id: "openai/mock-secondary",
        display_name: "openai/mock-secondary"
      }
    ]
  );
  const selectedClaudeModel = await fetch(
    `${dataUrl}/v1/models/${encodeURIComponent("anthropic.routekit.openai/mock-model")}`,
    {
      headers: {
        authorization: `Bearer ${claudeToken}`,
        "anthropic-version": "2023-06-01"
      }
    }
  );
  assert.equal(selectedClaudeModel.status, 200);

  if (process.env.ROUTEKIT_NATIVE_CLIENT_E2E === "1") {
    const claude = await runNative(
      "claude",
      [
        "--print",
        "--model",
        "anthropic.routekit.openai/mock-model",
        "--effort",
        "high",
        "--no-session-persistence",
        "Reply with ROUTEKIT_NATIVE_CLAUDE_OK and nothing else."
      ],
      project,
      {
        ...env,
        CLAUDE_CONFIG_DIR: claudeConfig,
        ANTHROPIC_AUTH_TOKEN: undefined
      }
    );
    assert.match(claude.stdout, /ROUTEKIT_NATIVE_CLAUDE_OK/);
    assert.ok(
      upstreamChatBodies.some(
        (body) => body.model === "mock-model" && body.reasoning_effort === "high"
      ),
      "Claude's native --effort selector must reach the routed provider"
    );

    // A direct native id remains available when exactly one RouteKit route
    // owns it; the installed custom picker ids are for `/model`, not a second
    // routing namespace that callers have to learn.
    const claudeBareNative = await runNative(
      "claude",
      [
        "--print",
        "--model",
        "mock-secondary",
        "--no-session-persistence",
        "Reply with ROUTEKIT_NATIVE_CLAUDE_OK and nothing else."
      ],
      project,
      {
        ...env,
        CLAUDE_CONFIG_DIR: claudeConfig,
        ANTHROPIC_AUTH_TOKEN: undefined
      }
    );
    assert.match(claudeBareNative.stdout, /ROUTEKIT_NATIVE_CLAUDE_OK/);
    assert.ok(upstreamModels.includes("mock-secondary"));
  }

  const statePath = join(state, "integrations", "native-clients.json");
  const stateContent = readFileSync(statePath, "utf8");
  assert.equal(stateContent.includes(codexToken), false);
  assert.equal(stateContent.includes(codexRotatedToken), false);
  assert.equal(stateContent.includes(claudeToken), false);

  const tokensBeforeNoToken = JSON.parse(
    (await run(["token", "list", "--json"], project, env)).stdout
  ) as { tokens: Array<{ id: string }> };
  const existingNoTokenCodex = JSON.parse(
    (
      await run(
        ["codex", "install", "--codex-home", codexHome, "--no-token", "--json"],
        project,
        env
      )
    ).stdout
  ) as { token?: string };
  const existingNoTokenClaude = JSON.parse(
    (
      await run(
        ["claude", "install", "--claude-config-dir", claudeConfig, "--no-token", "--json"],
        project,
        env
      )
    ).stdout
  ) as { token?: string };
  assert.equal(existingNoTokenCodex.token, undefined);
  assert.equal(existingNoTokenClaude.token, undefined);

  const noTokenCodexHome = join(home, ".codex-no-token");
  const noTokenClaudeConfig = join(home, ".claude-no-token");
  const noTokenCodex = JSON.parse(
    (
      await run(
        ["codex", "install", "--codex-home", noTokenCodexHome, "--no-token", "--json"],
        project,
        env
      )
    ).stdout
  ) as { token?: string; configPath?: string };
  const noTokenClaude = JSON.parse(
    (
      await run(
        ["claude", "install", "--claude-config-dir", noTokenClaudeConfig, "--no-token", "--json"],
        project,
        env
      )
    ).stdout
  ) as { token?: string; configPath?: string };
  assert.equal(noTokenCodex.token, undefined);
  assert.equal(noTokenClaude.token, undefined);
  assert.equal(existsSync(noTokenCodex.configPath!), true);
  assert.equal(existsSync(noTokenClaude.configPath!), true);
  const tokensAfterNoToken = JSON.parse(
    (await run(["token", "list", "--json"], project, env)).stdout
  ) as { tokens: Array<{ id: string }> };
  assert.deepEqual(
    tokensAfterNoToken.tokens.map((token) => token.id).sort(),
    tokensBeforeNoToken.tokens.map((token) => token.id).sort(),
    "--no-token must not issue a gateway token"
  );
  const stateAfterNoToken = JSON.parse(readFileSync(statePath, "utf8")) as {
    integrations: Array<{ configPath: string }>;
  };
  assert.equal(
    stateAfterNoToken.integrations.some((entry) => entry.configPath === noTokenCodex.configPath),
    false,
    "--no-token must not register a native credential"
  );
  assert.equal(
    stateAfterNoToken.integrations.some((entry) => entry.configPath === noTokenClaude.configPath),
    false,
    "--no-token must not register a native credential"
  );

  await run(["codex", "uninstall", "--codex-home", codexHome, "--json"], project, env);
  await run(["claude", "uninstall", "--claude-config-dir", claudeConfig, "--json"], project, env);
  await assertCredentialRemoved(codexCredentialLocation);
  await assertCredentialRemoved(claudeCredentialLocation);
  assert.equal(existsSync(statePath), true);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { version: 1, integrations: [] });
  const tokens = JSON.parse((await run(["token", "list", "--json"], project, env)).stdout) as {
    tokens: Array<{ label: string; revokedAt?: string }>;
  };
  assert.ok(
    tokens.tokens
      .filter((token) => token.label.startsWith("native-"))
      .every((token) => token.revokedAt !== undefined),
    "uninstall must revoke every dedicated native-client token"
  );
});
