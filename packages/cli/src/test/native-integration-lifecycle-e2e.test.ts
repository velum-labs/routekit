import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

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
  const upstream = createServer(async (request, response) => {
    upstreamRequests.push(request.url ?? "");
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: unknown };
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
    ["providers:", "  openai: {}", "defaultModel: openai/mock-model", ""].join("\n")
  );

  const codexInstalled = JSON.parse(
    (await run(["codex", "install", "--codex-home", codexHome, "--json"], project, env)).stdout
  ) as { token?: string; authTokenEnv?: string; configPath?: string };
  daemonStarted = true;
  assert.equal(codexInstalled.authTokenEnv, "ROUTEKIT_GATEWAY_TOKEN");
  assert.equal(typeof codexInstalled.token, "string");
  const codexToken = codexInstalled.token!;
  const codexConfigPath = codexInstalled.configPath!;
  const codexConfig = readFileSync(codexConfigPath, "utf8");
  assert.match(codexConfig, /env_key = "ROUTEKIT_GATEWAY_TOKEN"/);
  assert.equal(codexConfig.includes(codexToken), false);
  assert.equal(
    /^model\s*=/m.test(codexConfig),
    false,
    "install must not set Codex's default model"
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
        "routekit-model-1",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        "Reply with ROUTEKIT_NATIVE_CODEX_OK and nothing else."
      ],
      project,
      { ...env, CODEX_HOME: codexHome, ROUTEKIT_GATEWAY_TOKEN: codexToken }
    );
    assert.match(codex.stdout, /ROUTEKIT_NATIVE_CODEX_OK/);
    assert.ok(upstreamRequests.includes("/v1/responses"));
  }

  const codexUpdated = JSON.parse(
    (await run(["codex", "install", "--codex-home", codexHome, "--json"], project, env)).stdout
  ) as { token?: string };
  assert.equal(
    codexUpdated.token,
    undefined,
    "same-target reinstall must not reveal or reissue a token"
  );

  const codexRotated = JSON.parse(
    (
      await run(
        ["codex", "install", "--codex-home", codexHome, "--rotate-token", "--json"],
        project,
        env
      )
    ).stdout
  ) as { token?: string };
  assert.equal(typeof codexRotated.token, "string");
  assert.notEqual(codexRotated.token, codexToken);

  const claudeInstalled = JSON.parse(
    (await run(["claude", "install", "--claude-config-dir", claudeConfig, "--json"], project, env))
      .stdout
  ) as { token?: string; authTokenEnv?: string; configPath?: string };
  assert.equal(claudeInstalled.authTokenEnv, "ANTHROPIC_AUTH_TOKEN");
  assert.equal(typeof claudeInstalled.token, "string");
  const claudeSettings = readFileSync(claudeInstalled.configPath!, "utf8");
  assert.equal(claudeSettings.includes(claudeInstalled.token!), false);
  assert.equal(claudeSettings.includes("ANTHROPIC_AUTH_TOKEN"), false);

  if (process.env.ROUTEKIT_NATIVE_CLIENT_E2E === "1") {
    const claude = await runNative(
      "claude",
      [
        "--bare",
        "--print",
        "--model",
        "claude-openai/mock-model",
        "--no-session-persistence",
        "Reply with ROUTEKIT_NATIVE_CLAUDE_OK and nothing else."
      ],
      project,
      {
        ...env,
        CLAUDE_CONFIG_DIR: claudeConfig,
        ANTHROPIC_AUTH_TOKEN: claudeInstalled.token
      }
    );
    assert.match(claude.stdout, /ROUTEKIT_NATIVE_CLAUDE_OK/);
  }

  const statePath = join(state, "integrations", "native-clients.json");
  const stateContent = readFileSync(statePath, "utf8");
  assert.equal(stateContent.includes(codexToken), false);
  assert.equal(stateContent.includes(codexRotated.token!), false);
  assert.equal(stateContent.includes(claudeInstalled.token!), false);

  await run(["codex", "uninstall", "--codex-home", codexHome, "--json"], project, env);
  await run(["claude", "uninstall", "--claude-config-dir", claudeConfig, "--json"], project, env);
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
