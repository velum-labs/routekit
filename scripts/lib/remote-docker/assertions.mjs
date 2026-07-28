/**
 * Shared assertion helpers for remote Docker lifecycle stages.
 */
import { MOCK_MODEL, EXPECTED_COMPLETION, OWNER_USER, PEER_USER } from "./constants.mjs";
import { httpJson, parseJsonOutput } from "./client.mjs";
import { withRemotePath } from "./ssh.mjs";

/**
 * @param {{
 *   gatewayUrl: string;
 *   token: string;
 *   fail: (message: string, details?: unknown) => never;
 *   content?: string;
 *   prompt?: string;
 * }} input
 */
export async function assertChatCompletionOk(input) {
  const models = await httpJson(`${input.gatewayUrl}/v1/models`, { token: input.token });
  if (!models.ok || !Array.isArray(models.json?.data)) {
    input.fail("/v1/models failed", models);
  }
  const completion = await httpJson(`${input.gatewayUrl}/v1/chat/completions`, {
    token: input.token,
    body: {
      model: `openai/${MOCK_MODEL}`,
      messages: [{ role: "user", content: input.prompt ?? "ping" }]
    }
  });
  if (!completion.ok) {
    input.fail("chat completion failed", completion);
  }
  const expected = input.content ?? EXPECTED_COMPLETION;
  const content = completion.json?.choices?.[0]?.message?.content;
  if (content !== expected) {
    input.fail(`unexpected completion content: ${content}`, completion);
  }
  return completion;
}

/**
 * @param {{
 *   gatewayUrl: string;
 *   token: string;
 *   fail: (message: string, details?: unknown) => never;
 *   label?: string;
 * }} input
 */
export async function assertModelsOk(input) {
  const models = await httpJson(`${input.gatewayUrl}/v1/models`, { token: input.token });
  if (!models.ok) {
    input.fail(`${input.label ?? "models"} /v1/models failed`, models);
  }
  return models;
}

/**
 * @param {{
 *   ssh: Function;
 *   alias: string;
 *   configPath: string;
 *   version: string;
 *   fail: (message: string, details?: unknown) => never;
 *   label?: string;
 * }} input
 */
export async function assertRemoteCliVersion(input) {
  const result = await input.ssh(input.alias, withRemotePath("routekit version"), {
    configPath: input.configPath
  });
  if (!result.stdout.includes(input.version)) {
    input.fail(
      `${input.label ?? "remote"} CLI is not at version ${input.version}`,
      result
    );
  }
  return result;
}

/**
 * @param {{
 *   ssh: Function;
 *   alias: string;
 *   configPath: string;
 *   fail: (message: string, details?: unknown) => never;
 * }} input
 */
export async function assertOwnerStateModes(input) {
  const modes = await input.ssh(
    input.alias,
    [
      "stat -c '%a %n' ~/.routekit",
      "stat -c '%a %n' ~/.routekit/services/daemon.json",
      "stat -c '%a %n' ~/.routekit/services/daemon.public.json",
      "stat -c '%a %n' ~/.routekit/secrets/data-token"
    ].join(" && "),
    { configPath: input.configPath }
  );
  for (const [mode, suffix] of [
    ["711", ".routekit"],
    ["600", "daemon.json"],
    ["644", "daemon.public.json"],
    ["600", "data-token"]
  ]) {
    if (!modes.stdout.includes(`${mode} `) || !modes.stdout.includes(suffix)) {
      input.fail(`missing expected mode ${mode} for ${suffix}`, modes);
    }
  }
  return modes;
}

/**
 * Extract a daemon pid from `routekit status --json` output.
 * @param {string} stdout
 * @param {string} label
 * @param {(message: string, details?: unknown) => never} fail
 */
export function requireDaemonPid(stdout, label, fail) {
  const statusJson = parseJsonOutput(stdout, label);
  const pid = statusJson.daemon?.pid ?? statusJson.pid;
  if (typeof pid !== "number") {
    fail(`${label} missing daemon pid`, statusJson);
  }
  return { statusJson, pid };
}

export { OWNER_USER, PEER_USER };
