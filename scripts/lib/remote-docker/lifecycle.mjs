/**
 * Scenario stages for the remote Docker lifecycle suite.
 * Each function owns one stage and returns only the facts later stages need.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertChatCompletionOk,
  assertModelsOk,
  assertOwnerStateModes,
  assertRemoteCliVersion,
  requireDaemonPid
} from "./assertions.mjs";
import { httpJson, openLocalForwardTunnel, parseJsonOutput } from "./client.mjs";
import { OWNER_REMOTE_NAME, PEER_REMOTE_NAME, SSH_ALIAS } from "./constants.mjs";
import { commandTimeoutMs, freePort, waitForHttpOk } from "./process.mjs";
import { privateCliInstallCommand, withRemotePath } from "./ssh.mjs";

/**
 * @typedef {{
 *   runCli: Function;
 *   ssh: Function;
 *   log: (message: string) => void;
 *   fail: (message: string, details?: unknown) => never;
 *   setStage: (name: string) => void;
 *   secrets: string[];
 *   cleanup: { add: Function };
 *   ownerEnv: NodeJS.ProcessEnv;
 *   peerEnv: NodeJS.ProcessEnv;
 *   ownerConfigPath: string;
 *   ownerState: string;
 *   peerState: string;
 *   initialVersion: string;
 *   candidateVersion: string;
 * }} LifecycleCtx
 */

/** @param {LifecycleCtx} ctx */
export async function installOwner(ctx) {
  ctx.setStage("owner-remote-install");
  const install = await ctx.runCli(
    ["remote", "install", SSH_ALIAS, "--version", ctx.initialVersion, "--json"],
    ctx.ownerEnv,
    { timeoutMs: commandTimeoutMs("remoteInstall") }
  );
  const installJson = parseJsonOutput(install.stdout, "remote install");
  ctx.log(`owner install steps: ${JSON.stringify(installJson.steps ?? [])}`);
  if (installJson.blocked !== undefined) {
    ctx.fail("owner remote install blocked before daemon start", installJson);
  }
  if (installJson.gateway === undefined) {
    ctx.fail("owner remote install did not report a gateway", installJson);
  }
  if (installJson.installedVersion !== ctx.initialVersion) {
    ctx.log(
      `install reported version ${installJson.installedVersion ?? "unknown"} (requested ${ctx.initialVersion})`
    );
  }
  await assertRemoteCliVersion({
    ssh: ctx.ssh,
    alias: SSH_ALIAS,
    configPath: ctx.ownerConfigPath,
    version: ctx.initialVersion,
    fail: ctx.fail,
    label: "owner"
  });
  ctx.log(`owner installed ${ctx.initialVersion}`);
  return { installJson };
}

/** @param {LifecycleCtx} ctx */
export async function openGatewayTunnel(ctx) {
  ctx.setStage("gateway-tunnel");
  const gatewayLocalPort = await freePort();
  const tunnel = openLocalForwardTunnel({
    configPath: ctx.ownerConfigPath,
    alias: SSH_ALIAS,
    localPort: gatewayLocalPort
  });
  ctx.cleanup.add("stop ssh tunnel", async () => {
    tunnel.stop();
  });
  const gatewayUrl = `http://127.0.0.1:${gatewayLocalPort}`;
  await waitForHttpOk(`${gatewayUrl}/health`, { timeoutMs: 60_000 });
  ctx.log(`gateway tunnel healthy at ${gatewayUrl}`);
  return { gatewayLocalPort, gatewayUrl, tunnel };
}

/**
 * @param {LifecycleCtx & { gatewayUrl: string }} ctx
 */
export async function enrollOwner(ctx) {
  ctx.setStage("owner-enroll");
  const enrolled = await ctx.runCli(
    ["remote", "add", OWNER_REMOTE_NAME, "--url", ctx.gatewayUrl, "--ssh", SSH_ALIAS, "--json"],
    ctx.ownerEnv,
    { timeoutMs: commandTimeoutMs("remoteAdd") }
  );
  const enrolledJson = parseJsonOutput(enrolled.stdout, "remote add owner");
  if (enrolledJson.remote?.name !== OWNER_REMOTE_NAME) {
    ctx.fail("owner enrollment did not return the remote", enrolledJson);
  }
  const ownerTokenPath = join(ctx.ownerState, "secrets", `remote-${OWNER_REMOTE_NAME}`);
  const ownerToken = readFileSync(ownerTokenPath, "utf8").trim();
  ctx.secrets.push(ownerToken);
  ctx.log("owner remote enrolled");
  return { ownerToken };
}

/**
 * @param {LifecycleCtx & { gatewayUrl: string, ownerToken: string }} ctx
 */
export async function runOwnerTraffic(ctx) {
  ctx.setStage("owner-traffic");
  await assertChatCompletionOk({
    gatewayUrl: ctx.gatewayUrl,
    token: ctx.ownerToken,
    fail: ctx.fail
  });
  const status = await ctx.runCli(
    ["--remote", OWNER_REMOTE_NAME, "status", "--json"],
    ctx.ownerEnv
  );
  const { pid: ownerPid } = requireDaemonPid(status.stdout, "owner status", ctx.fail);
  ctx.log(`owner traffic ok (pid ${ownerPid})`);
  return { ownerPid };
}

/** @param {LifecycleCtx} ctx */
export async function installPeerCli(ctx) {
  ctx.setStage("peer-cli-install");
  const peerInstall = await ctx.ssh(
    `${SSH_ALIAS}-peer`,
    privateCliInstallCommand(ctx.initialVersion),
    {
      configPath: ctx.ownerConfigPath,
      timeoutMs: commandTimeoutMs("remoteInstall")
    }
  );
  if (!peerInstall.stdout.includes(ctx.initialVersion)) {
    ctx.fail("peer CLI install did not report the initial candidate version", peerInstall);
  }
  ctx.log("peer CLI installed");
}

/**
 * @param {LifecycleCtx & { gatewayUrl: string }} ctx
 */
export async function enrollPeer(ctx) {
  ctx.setStage("peer-join");
  const issue = await ctx.runCli(
    [
      "--remote",
      OWNER_REMOTE_NAME,
      "token",
      "issue",
      "docker-peer-admin",
      "--plane",
      "control",
      "--json"
    ],
    ctx.ownerEnv
  );
  const issueJson = parseJsonOutput(issue.stdout, "token issue");
  let joinCredential =
    typeof issueJson.joinCredential === "string" ? issueJson.joinCredential : undefined;
  if (joinCredential === undefined || !joinCredential.startsWith("rk1_")) {
    const match = `${issue.stdout}\n${issue.stderr}`.match(/\brk1_[A-Za-z0-9_-]+\b/);
    if (match === null) ctx.fail("control token issue returned no join credential", issue);
    joinCredential = match[0];
  }
  ctx.secrets.push(joinCredential);
  const controlTokenId = typeof issueJson.id === "string" ? issueJson.id : undefined;

  const peerAdd = await ctx.runCli(
    [
      "remote",
      "add",
      PEER_REMOTE_NAME,
      "--url",
      ctx.gatewayUrl,
      "--ssh",
      `${SSH_ALIAS}-peer`,
      "--join",
      "-",
      "--json"
    ],
    ctx.peerEnv,
    { input: `${joinCredential}\n`, timeoutMs: commandTimeoutMs("remoteAdd") }
  );
  const peerAddJson = parseJsonOutput(peerAdd.stdout, "remote add peer");
  if (peerAddJson.remote?.name !== PEER_REMOTE_NAME) {
    ctx.fail("peer enrollment did not return the remote", peerAddJson);
  }
  const peerToken = readFileSync(
    join(ctx.peerState, "secrets", `remote-${PEER_REMOTE_NAME}`),
    "utf8"
  ).trim();
  ctx.secrets.push(peerToken);
  ctx.log("peer remote enrolled with --join");
  return { peerToken, controlTokenId };
}

/**
 * @param {LifecycleCtx & {
 *   gatewayUrl: string;
 *   peerToken: string;
 *   ownerPid: number;
 * }} ctx
 */
export async function runPeerTraffic(ctx) {
  ctx.setStage("peer-traffic");
  const peerStatus = await ctx.runCli(
    ["--remote", PEER_REMOTE_NAME, "status", "--json"],
    ctx.peerEnv
  );
  const peerStatusJson = parseJsonOutput(peerStatus.stdout, "peer status");
  if ((peerStatusJson.daemon?.pid ?? peerStatusJson.pid) !== ctx.ownerPid) {
    ctx.log(
      `peer status pid ${peerStatusJson.daemon?.pid ?? peerStatusJson.pid} (owner was ${ctx.ownerPid})`
    );
  }
  await assertModelsOk({
    gatewayUrl: ctx.gatewayUrl,
    token: ctx.peerToken,
    fail: ctx.fail,
    label: "peer"
  });
  const peerCompletion = await httpJson(`${ctx.gatewayUrl}/v1/chat/completions`, {
    token: ctx.peerToken,
    body: {
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "peer-ping" }]
    }
  });
  if (!peerCompletion.ok) ctx.fail("peer chat completion failed", peerCompletion);

  await assertOwnerStateModes({
    ssh: ctx.ssh,
    alias: SSH_ALIAS,
    configPath: ctx.ownerConfigPath,
    fail: ctx.fail
  });
  ctx.log("peer traffic and file modes ok");
}

/**
 * @param {LifecycleCtx & { gatewayUrl: string, peerToken: string }} ctx
 */
export async function restartOwner(ctx) {
  ctx.setStage("owner-restart");
  const beforeRestart = await ctx.ssh(SSH_ALIAS, withRemotePath("routekit --local --json status"), {
    configPath: ctx.ownerConfigPath
  });
  const beforeJson = parseJsonOutput(beforeRestart.stdout, "status before restart");
  const beforePid = beforeJson.daemon?.pid ?? beforeJson.pid;
  await ctx.ssh(SSH_ALIAS, withRemotePath("routekit --local --json stop --force"), {
    configPath: ctx.ownerConfigPath
  });
  await ctx.ssh(SSH_ALIAS, withRemotePath("routekit --local --json start"), {
    configPath: ctx.ownerConfigPath,
    timeoutMs: 120_000
  });
  await waitForHttpOk(`${ctx.gatewayUrl}/health`, { timeoutMs: 60_000 });
  const afterRestart = await ctx.ssh(SSH_ALIAS, withRemotePath("routekit --local --json status"), {
    configPath: ctx.ownerConfigPath
  });
  const afterJson = parseJsonOutput(afterRestart.stdout, "status after restart");
  const afterPid = afterJson.daemon?.pid ?? afterJson.pid;
  if (afterPid === beforePid) {
    ctx.fail("daemon pid did not change after restart", { beforeJson, afterJson });
  }
  const peerAfterRestart = await ctx.runCli(
    ["--remote", PEER_REMOTE_NAME, "status", "--json"],
    ctx.peerEnv
  );
  parseJsonOutput(peerAfterRestart.stdout, "peer status after restart");
  await assertModelsOk({
    gatewayUrl: ctx.gatewayUrl,
    token: ctx.peerToken,
    fail: (message, details) =>
      ctx.fail("peer lost data-plane access after owner restart", details ?? message),
    label: "peer-after-restart"
  });
  ctx.log(`owner restarted (${beforePid} -> ${afterPid}); peer still works`);
  return { afterPid };
}

/**
 * @param {LifecycleCtx & {
 *   gatewayUrl: string;
 *   ownerToken: string;
 *   peerToken: string;
 *   afterPid: number;
 * }} ctx
 */
export async function upgradeToCandidate(ctx) {
  ctx.setStage("upgrade-to-candidate");
  const upgradeOwner = await ctx.runCli(
    ["remote", "install", SSH_ALIAS, "--version", ctx.candidateVersion, "--force", "--json"],
    ctx.ownerEnv,
    { timeoutMs: commandTimeoutMs("remoteInstall") }
  );
  parseJsonOutput(upgradeOwner.stdout, "remote install candidate");
  const daemonUpgrade = await ctx.ssh(
    SSH_ALIAS,
    withRemotePath("routekit --local --json daemon upgrade"),
    {
      configPath: ctx.ownerConfigPath,
      timeoutMs: 120_000
    }
  );
  const daemonUpgradeJson = parseJsonOutput(daemonUpgrade.stdout, "daemon upgrade");
  await assertRemoteCliVersion({
    ssh: ctx.ssh,
    alias: SSH_ALIAS,
    configPath: ctx.ownerConfigPath,
    version: ctx.candidateVersion,
    fail: ctx.fail,
    label: "owner"
  });
  await ctx.ssh(`${SSH_ALIAS}-peer`, privateCliInstallCommand(ctx.candidateVersion), {
    configPath: ctx.ownerConfigPath,
    timeoutMs: commandTimeoutMs("remoteInstall")
  });
  await waitForHttpOk(`${ctx.gatewayUrl}/health`, { timeoutMs: 60_000 });
  const upgradedStatus = await ctx.runCli(
    ["--remote", OWNER_REMOTE_NAME, "status", "--json"],
    ctx.ownerEnv
  );
  const upgradedStatusJson = parseJsonOutput(upgradedStatus.stdout, "status after upgrade");
  const upgradedPid = upgradedStatusJson.daemon?.pid ?? upgradedStatusJson.pid;
  if (upgradedPid === ctx.afterPid && daemonUpgradeJson.action === "upgraded") {
    ctx.log("daemon pid unchanged after upgrade action; relying on version checks");
  }
  const packageVersion =
    upgradedStatusJson.daemon?.packageVersion ??
    upgradedStatusJson.packageVersion ??
    upgradedStatusJson.remoteVersion;
  if (
    typeof packageVersion === "string" &&
    packageVersion.length > 0 &&
    packageVersion !== ctx.candidateVersion
  ) {
    ctx.fail(
      `daemon package version ${packageVersion} != candidate ${ctx.candidateVersion}`,
      upgradedStatusJson
    );
  }
  await assertModelsOk({
    gatewayUrl: ctx.gatewayUrl,
    token: ctx.ownerToken,
    fail: (message, details) => ctx.fail("owner token failed after upgrade", details ?? message),
    label: "owner-post-upgrade"
  });
  await assertModelsOk({
    gatewayUrl: ctx.gatewayUrl,
    token: ctx.peerToken,
    fail: (message, details) => ctx.fail("peer token failed after upgrade", details ?? message),
    label: "peer-post-upgrade"
  });

  const idempotent = await ctx.runCli(
    ["remote", "install", SSH_ALIAS, "--version", ctx.candidateVersion, "--json"],
    ctx.ownerEnv,
    { timeoutMs: commandTimeoutMs("remoteInstall") }
  );
  const idempotentJson = parseJsonOutput(idempotent.stdout, "idempotent install");
  const installStep = (idempotentJson.steps ?? []).find((step) => step.id === "install");
  if (installStep?.status !== "skipped") {
    ctx.fail("idempotent candidate reinstall should skip install", idempotentJson);
  }
  const pids = await ctx.ssh(SSH_ALIAS, "pgrep -af '[r]outekit' || true", {
    configPath: ctx.ownerConfigPath
  });
  ctx.log(`routekit processes after upgrade:\n${pids.stdout.trim() || "(none)"}`);
  ctx.log("upgrade + persistence + idempotent reinstall ok");
}

/**
 * @param {LifecycleCtx & {
 *   gatewayUrl: string;
 *   ownerToken: string;
 *   peerToken: string;
 *   controlTokenId?: string;
 * }} ctx
 */
export async function revokePeer(ctx) {
  ctx.setStage("revoke");
  const tokenList = await ctx.runCli(
    ["--remote", OWNER_REMOTE_NAME, "token", "list", "--json"],
    ctx.ownerEnv
  );
  const tokenListJson = parseJsonOutput(tokenList.stdout, "token list");
  const tokens = tokenListJson.tokens ?? tokenListJson;
  const peerData = Array.isArray(tokens)
    ? tokens.find(
        (token) =>
          typeof token.label === "string" && token.label.includes(`remote-${PEER_REMOTE_NAME}`)
      )
    : undefined;
  if (peerData?.id === undefined) {
    ctx.fail("could not find peer data token to revoke", tokenListJson);
  }
  await ctx.runCli(
    ["--remote", OWNER_REMOTE_NAME, "token", "revoke", peerData.id, "--json"],
    ctx.ownerEnv
  );
  const revokedPeer = await httpJson(`${ctx.gatewayUrl}/v1/models`, {
    token: ctx.peerToken
  });
  if (revokedPeer.status !== 401) {
    ctx.fail(`expected 401 after peer token revoke, got ${revokedPeer.status}`, revokedPeer);
  }
  if (typeof ctx.controlTokenId === "string" && ctx.controlTokenId.length > 0) {
    await ctx.runCli(
      ["--remote", OWNER_REMOTE_NAME, "token", "revoke", ctx.controlTokenId, "--json"],
      ctx.ownerEnv,
      { allowFailure: true }
    );
  }
  await assertModelsOk({
    gatewayUrl: ctx.gatewayUrl,
    token: ctx.ownerToken,
    fail: (message, details) =>
      ctx.fail("owner token should still work after peer revoke", details ?? message),
    label: "owner-after-revoke"
  });
  ctx.log("revocation ok");
}

/** @param {LifecycleCtx} ctx */
export async function teardownDaemon(ctx) {
  ctx.setStage("teardown-daemon");
  await ctx.ssh(SSH_ALIAS, withRemotePath("routekit --local --json stop --force"), {
    configPath: ctx.ownerConfigPath,
    allowFailure: true
  });
}
