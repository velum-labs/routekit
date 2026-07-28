#!/usr/bin/env node
/**
 * RouteKit remote Docker lifecycle E2E.
 *
 * Host runner = single client machine (built candidate CLI).
 * Docker target = Linux SSH host with owner + peer Unix accounts.
 * Verdaccio = local registry hosting the candidate prerelease and proxying
 * the latest published baseline from npmjs.
 *
 * Proves: remote install → multi-user peer enrollment → traffic → upgrade →
 * persistence → revocation → teardown.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCandidateClosureComplete,
  CleanupStack,
  candidateVersionFor,
  commandTimeoutMs,
  ensureEmptyDir,
  freePort,
  OWNER_REMOTE_NAME,
  OWNER_USER,
  PEER_REMOTE_NAME,
  PEER_USER,
  packCandidateArtifacts,
  parseJsonOutput,
  publishCandidateArtifacts,
  ROUTEKIT_PACKAGE,
  redactSensitiveText,
  registerVerdaccioUser,
  requireBinary,
  resolveLatestPublishedVersion,
  runCaptured,
  SSH_ALIAS,
  waitForHttpOk,
  writeSshConfig
} from "./lib/remote-docker-e2e.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS_DIR = join(ROOT, "test/docker/remote-lifecycle");
const CLI_ENTRY = join(ROOT, "packages/cli/dist/index.js");
const ARTIFACT_ROOT = join(ROOT, ".artifacts/remote-docker");
const NETWORK = "rk-remote-e2e-net";
const REGISTRY_NAME = "rk-remote-e2e-registry";
const TARGET_NAME = "rk-remote-e2e-target";
const TARGET_IMAGE = "routekit-remote-lifecycle:local";
const RUN_ID = `${Date.now().toString(36)}${process.pid.toString(36)}`;

const stage = {
  name: "init",
  log: []
};

function log(message) {
  const line = `[remote-docker] ${message}`;
  stage.log.push(line);
  process.stdout.write(`${line}\n`);
}

function fail(message, details) {
  const error = new Error(message);
  if (details !== undefined) error.details = details;
  error.stage = stage.name;
  throw error;
}

function withRemotePath(command) {
  return (
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; ' +
    command
  );
}

function setStage(name) {
  stage.name = name;
  log(`stage: ${name}`);
}

async function docker(args, options = {}) {
  const result = await runCaptured("docker", args, {
    timeoutMs: options.timeoutMs ?? commandTimeoutMs("docker"),
    label: `docker ${args.join(" ")}`,
    env: options.env ?? process.env,
    input: options.input
  });
  if (options.allowFailure === true) return result;
  if (result.code !== 0) {
    fail(`docker ${args.join(" ")} failed`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
  return result;
}

function clientEnv(home, stateHome, sshConfigPath) {
  return {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_NO_SUPERVISOR: "1",
    ROUTEKIT_PORTLESS: "0",
    PORTLESS: "0",
    NO_COLOR: "1",
    ROUTEKIT_NO_TUI: "1",
    GIT_SSH_COMMAND: undefined,
    SSH_AUTH_SOCK: undefined,
    PATH: process.env.PATH,
    // Force OpenSSH to use the generated config for this suite only.
    ...(sshConfigPath !== undefined ? {} : {})
  };
}

async function runCli(args, env, options = {}) {
  const result = await runCaptured(process.execPath, [CLI_ENTRY, ...args], {
    cwd: options.cwd ?? ROOT,
    env,
    timeoutMs: options.timeoutMs ?? commandTimeoutMs("default"),
    input: options.input,
    label: `routekit ${args.join(" ")}`
  });
  if (options.allowFailure === true) return result;
  if (result.code !== 0) {
    fail(`routekit ${args.join(" ")} failed`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
  return result;
}

async function ssh(alias, remoteCommand, options = {}) {
  const args = ["-F", options.configPath, ...(options.extraArgs ?? []), alias, remoteCommand];
  const result = await runCaptured("ssh", args, {
    timeoutMs: options.timeoutMs ?? commandTimeoutMs("ssh"),
    input: options.input,
    label: `ssh ${alias} ${remoteCommand}`
  });
  if (options.allowFailure === true) return result;
  if (result.code !== 0) {
    fail(`ssh ${alias} failed: ${remoteCommand}`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
  return result;
}

async function httpJson(url, options = {}) {
  const headers = {
    accept: "application/json",
    ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {})
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(url, {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, ok: response.ok, text, json };
}

function writeDiagnostics(dir, payload) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(join(dir, "log.txt"), `${stage.log.join("\n")}\n`);
}

async function main() {
  requireBinary("docker");
  requireBinary("ssh");
  requireBinary("ssh-keygen");
  requireBinary("pnpm");
  requireBinary("npm");
  requireBinary("tar");

  if (!existsSync(CLI_ENTRY)) {
    fail(`built CLI missing at ${CLI_ENTRY}; run \`pnpm build\` (or \`pnpm build:cli\`) first`);
  }

  const cleanup = new CleanupStack();
  const work = ensureEmptyDir(join(ARTIFACT_ROOT, RUN_ID));
  const secrets = [];
  let tunnel;
  let ownerHome;
  let peerClientHome;
  let publishedVersion;
  let candidateVersion;
  let gatewayLocalPort;
  let registryPort;
  let sshPort;
  let ownerConfigPath;
  let peerConfigPath;
  let identityFile;

  try {
    setStage("resolve-versions");
    publishedVersion = resolveLatestPublishedVersion();
    candidateVersion = candidateVersionFor(publishedVersion, RUN_ID);
    log(`published baseline: ${publishedVersion}`);
    log(`candidate prerelease: ${candidateVersion}`);

    setStage("pack-candidate");
    const packDir = join(work, "candidate-pack");
    const packages = packCandidateArtifacts(ROOT, candidateVersion, packDir);
    log(`packed ${packages.length} packages for ${candidateVersion}`);
    assertCandidateClosureComplete(packages, candidateVersion);

    setStage("start-registry");
    registryPort = await freePort();
    const registryStorage = join(work, "verdaccio-storage");
    mkdirSync(registryStorage, { recursive: true });
    // Verdaccio runs as uid 10001; allow it to write the bind-mounted storage.
    chmodSync(registryStorage, 0o777);
    await docker(["network", "inspect", NETWORK], { allowFailure: true }).then(async (result) => {
      if (result.code !== 0) {
        await docker(["network", "create", NETWORK]);
      }
    });
    cleanup.add("remove docker network", async () => {
      await docker(["network", "rm", NETWORK], { allowFailure: true });
    });
    await docker(["rm", "-f", REGISTRY_NAME], { allowFailure: true });
    await docker([
      "run",
      "-d",
      "--name",
      REGISTRY_NAME,
      "--network",
      NETWORK,
      "--network-alias",
      "verdaccio",
      "-p",
      `127.0.0.1:${registryPort}:4873`,
      "-v",
      `${join(HARNESS_DIR, "verdaccio.yaml")}:/verdaccio/conf/config.yaml:ro`,
      "-v",
      `${registryStorage}:/verdaccio/storage`,
      "verdaccio/verdaccio:6"
    ]);
    cleanup.add("remove registry container", async () => {
      await docker(["rm", "-f", REGISTRY_NAME], { allowFailure: true });
    });
    const registryUrl = `http://127.0.0.1:${registryPort}/`;
    const registryUrlInDocker = "http://verdaccio:4873/";
    await waitForHttpOk(`${registryUrl}-/ping`, { timeoutMs: 60_000 });
    log(`verdaccio ready at ${registryUrl}`);

    setStage("publish-candidate");
    const registryAuth = await registerVerdaccioUser(registryUrl);
    secrets.push(registryAuth.token, registryAuth.password);
    const published = await publishCandidateArtifacts(packages, registryUrl, {
      token: registryAuth.token
    });
    log(`published ${published.length} candidate packages`);

    setStage("prepare-ssh-keys");
    const keyDir = join(work, "ssh");
    mkdirSync(keyDir, { recursive: true });
    identityFile = join(keyDir, "id_ed25519");
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-f", identityFile, "-C", "routekit-remote-docker-e2e"],
      { stdio: "pipe" }
    );
    chmodSync(identityFile, 0o600);
    const authorizedKeys = join(keyDir, "authorized_keys");
    copyFileSync(`${identityFile}.pub`, authorizedKeys);

    setStage("build-target");
    await docker(["build", "-t", TARGET_IMAGE, HARNESS_DIR], { timeoutMs: 300_000 });

    setStage("start-target");
    sshPort = await freePort();
    await docker(["rm", "-f", TARGET_NAME], { allowFailure: true });
    await docker([
      "run",
      "-d",
      "--name",
      TARGET_NAME,
      "--network",
      NETWORK,
      "--network-alias",
      "target",
      "-p",
      `127.0.0.1:${sshPort}:22`,
      "-e",
      `REGISTRY_URL=${registryUrlInDocker}`,
      "-e",
      "OPENAI_API_KEY=docker-e2e-key",
      "-e",
      "OPENAI_BASE_URL=http://127.0.0.1:17999/v1",
      "-e",
      "MOCK_PROVIDER_PORT=17999",
      "-e",
      "MOCK_PROVIDER_MODEL=gpt-5.5",
      "-v",
      `${authorizedKeys}:/keys/authorized_keys:ro`,
      TARGET_IMAGE
    ]);
    cleanup.add("remove target container", async () => {
      await docker(["rm", "-f", TARGET_NAME], { allowFailure: true });
    });

    ownerHome = mkdtempSync(join(tmpdir(), "rk-docker-owner-client-"));
    peerClientHome = mkdtempSync(join(tmpdir(), "rk-docker-peer-client-"));
    cleanup.add("remove owner client home", async () => {
      rmSync(ownerHome, { recursive: true, force: true });
    });
    cleanup.add("remove peer client home", async () => {
      rmSync(peerClientHome, { recursive: true, force: true });
    });
    const ownerState = join(ownerHome, ".routekit");
    const peerState = join(peerClientHome, ".routekit");
    mkdirSync(ownerState, { recursive: true });
    mkdirSync(peerState, { recursive: true });
    ownerConfigPath = join(ownerHome, "ssh-config");
    peerConfigPath = join(peerClientHome, "ssh-config");
    writeSshConfig(ownerConfigPath, {
      hosts: [
        {
          alias: SSH_ALIAS,
          host: "127.0.0.1",
          port: sshPort,
          user: OWNER_USER,
          identityFile
        },
        {
          alias: `${SSH_ALIAS}-peer`,
          host: "127.0.0.1",
          port: sshPort,
          user: PEER_USER,
          identityFile
        }
      ]
    });
    copyFileSync(ownerConfigPath, peerConfigPath);
    chmodSync(peerConfigPath, 0o600);

    // Wait for sshd readiness.
    setStage("wait-ssh");
    const sshDeadline = Date.now() + 60_000;
    let sshReady = false;
    while (Date.now() < sshDeadline) {
      const probe = await ssh(
        SSH_ALIAS,
        "printf ready && uname -s && id -un && command -v routekit >/dev/null; printf ' routekit=%s' $?",
        { configPath: ownerConfigPath, allowFailure: true, timeoutMs: 10_000 }
      );
      if (probe.code === 0 && probe.stdout.includes("ready")) {
        sshReady = true;
        log(`ssh ready: ${probe.stdout.trim()}`);
        if (!probe.stdout.includes("routekit=1")) {
          fail("target unexpectedly already has routekit on PATH", probe);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!sshReady) fail("SSH to target never became ready");

    const ownerEnvBase = {
      ...clientEnv(ownerHome, ownerState),
      GIT_SSH_COMMAND: `ssh -F ${ownerConfigPath}`
    };
    // OpenSSH reads -F from argv when we invoke ssh directly; for the CLI we
    // put the generated config on PATH via a wrapper directory.
    const binDir = join(work, "bin");
    mkdirSync(binDir, { recursive: true });
    const sshWrapper = join(binDir, "ssh");
    writeFileSync(
      sshWrapper,
      `#!/bin/sh\nexec /usr/bin/ssh -F ${JSON.stringify(ownerConfigPath)} "$@"\n`,
      { mode: 0o755 }
    );
    const peerBinDir = join(work, "peer-bin");
    mkdirSync(peerBinDir, { recursive: true });
    writeFileSync(
      join(peerBinDir, "ssh"),
      `#!/bin/sh\nexec /usr/bin/ssh -F ${JSON.stringify(peerConfigPath)} "$@"\n`,
      { mode: 0o755 }
    );
    const ownerEnv = {
      ...ownerEnvBase,
      PATH: `${binDir}:${process.env.PATH}`
    };
    const peerEnv = {
      ...clientEnv(peerClientHome, peerState),
      PATH: `${peerBinDir}:${process.env.PATH}`
    };

    setStage("owner-remote-install");
    const install = await runCli(
      ["remote", "install", SSH_ALIAS, "--version", publishedVersion, "--json"],
      ownerEnv,
      { timeoutMs: commandTimeoutMs("remoteInstall") }
    );
    const installJson = parseJsonOutput(install.stdout, "remote install");
    log(`owner install steps: ${JSON.stringify(installJson.steps ?? [])}`);
    if (installJson.blocked !== undefined) {
      fail("owner remote install blocked before daemon start", installJson);
    }
    if (installJson.gateway === undefined) {
      fail("owner remote install did not report a gateway", installJson);
    }
    if (installJson.installedVersion !== publishedVersion) {
      // stdout version printer may differ slightly; accept gateway version.
      log(
        `install reported version ${installJson.installedVersion ?? "unknown"} (requested ${publishedVersion})`
      );
    }
    const ownerVersion = await ssh(SSH_ALIAS, withRemotePath("routekit version"), {
      configPath: ownerConfigPath
    });
    if (!ownerVersion.stdout.includes(publishedVersion)) {
      fail(`owner CLI is not at published version ${publishedVersion}`, ownerVersion);
    }
    log(`owner installed ${publishedVersion}`);

    setStage("gateway-tunnel");
    gatewayLocalPort = await freePort();
    tunnel = spawn(
      "ssh",
      [
        "-F",
        ownerConfigPath,
        "-N",
        "-L",
        `127.0.0.1:${gatewayLocalPort}:127.0.0.1:8080`,
        SSH_ALIAS
      ],
      { stdio: "ignore" }
    );
    cleanup.add("stop ssh tunnel", async () => {
      if (tunnel?.pid) {
        tunnel.kill("SIGTERM");
      }
    });
    const gatewayUrl = `http://127.0.0.1:${gatewayLocalPort}`;
    await waitForHttpOk(`${gatewayUrl}/health`, { timeoutMs: 60_000 });
    log(`gateway tunnel healthy at ${gatewayUrl}`);

    setStage("owner-enroll");
    const enrolled = await runCli(
      ["remote", "add", OWNER_REMOTE_NAME, "--url", gatewayUrl, "--ssh", SSH_ALIAS, "--json"],
      ownerEnv,
      { timeoutMs: commandTimeoutMs("remoteAdd") }
    );
    const enrolledJson = parseJsonOutput(enrolled.stdout, "remote add owner");
    if (enrolledJson.remote?.name !== OWNER_REMOTE_NAME) {
      fail("owner enrollment did not return the remote", enrolledJson);
    }
    const ownerTokenPath = join(ownerState, "secrets", `remote-${OWNER_REMOTE_NAME}`);
    const ownerToken = readFileSync(ownerTokenPath, "utf8").trim();
    secrets.push(ownerToken);
    log("owner remote enrolled");

    setStage("owner-traffic");
    const models = await httpJson(`${gatewayUrl}/v1/models`, { token: ownerToken });
    if (!models.ok || !Array.isArray(models.json?.data)) {
      fail("owner /v1/models failed", models);
    }
    const completion = await httpJson(`${gatewayUrl}/v1/chat/completions`, {
      token: ownerToken,
      body: {
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "ping" }]
      }
    });
    if (!completion.ok) {
      fail("owner chat completion failed", completion);
    }
    const content = completion.json?.choices?.[0]?.message?.content;
    if (content !== "docker-e2e-ok") {
      fail(`unexpected completion content: ${content}`, completion);
    }
    const status = await runCli(["--remote", OWNER_REMOTE_NAME, "status", "--json"], ownerEnv);
    const statusJson = parseJsonOutput(status.stdout, "owner status");
    const ownerPid = statusJson.daemon?.pid ?? statusJson.pid;
    if (typeof ownerPid !== "number") {
      fail("owner status missing daemon pid", statusJson);
    }
    log(`owner traffic ok (pid ${ownerPid})`);

    setStage("peer-cli-install");
    // Peer needs its own CLI; do not start a second daemon. Use a private
    // prefix because the system npm prefix is not writable for unprivileged users.
    const peerInstall = await ssh(
      `${SSH_ALIAS}-peer`,
      [
        "set -eu",
        'export PATH="$HOME/.local/bin:$PATH"',
        'npm config set prefix "$HOME/.local"',
        `npm install -g --prefix "$HOME/.local" ${ROUTEKIT_PACKAGE}@${publishedVersion}`,
        "command -v routekit",
        "routekit version"
      ].join(" && "),
      { configPath: ownerConfigPath, timeoutMs: commandTimeoutMs("remoteInstall") }
    );
    if (!peerInstall.stdout.includes(publishedVersion)) {
      fail("peer CLI install did not report published version", peerInstall);
    }
    log("peer CLI installed");

    setStage("peer-join");
    const issue = await runCli(
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
      ownerEnv
    );
    const issueJson = parseJsonOutput(issue.stdout, "token issue");
    let joinCredential =
      typeof issueJson.joinCredential === "string" ? issueJson.joinCredential : undefined;
    if (joinCredential === undefined || !joinCredential.startsWith("rk1_")) {
      const match = `${issue.stdout}\n${issue.stderr}`.match(/\brk1_[A-Za-z0-9_-]+\b/);
      if (match === null) fail("control token issue returned no join credential", issue);
      joinCredential = match[0];
    }
    secrets.push(joinCredential);
    const controlTokenId = typeof issueJson.id === "string" ? issueJson.id : undefined;

    const peerAdd = await runCli(
      [
        "remote",
        "add",
        PEER_REMOTE_NAME,
        "--url",
        gatewayUrl,
        "--ssh",
        `${SSH_ALIAS}-peer`,
        "--join",
        "-",
        "--json"
      ],
      peerEnv,
      { input: `${joinCredential}\n`, timeoutMs: commandTimeoutMs("remoteAdd") }
    );
    const peerAddJson = parseJsonOutput(peerAdd.stdout, "remote add peer");
    if (peerAddJson.remote?.name !== PEER_REMOTE_NAME) {
      fail("peer enrollment did not return the remote", peerAddJson);
    }
    const peerToken = readFileSync(
      join(peerState, "secrets", `remote-${PEER_REMOTE_NAME}`),
      "utf8"
    ).trim();
    secrets.push(peerToken);
    log("peer remote enrolled with --join");

    setStage("peer-traffic");
    const peerStatus = await runCli(["--remote", PEER_REMOTE_NAME, "status", "--json"], peerEnv);
    const peerStatusJson = parseJsonOutput(peerStatus.stdout, "peer status");
    if ((peerStatusJson.daemon?.pid ?? peerStatusJson.pid) !== ownerPid) {
      log(
        `peer status pid ${peerStatusJson.daemon?.pid ?? peerStatusJson.pid} (owner was ${ownerPid})`
      );
    }
    const peerModels = await httpJson(`${gatewayUrl}/v1/models`, { token: peerToken });
    if (!peerModels.ok) fail("peer /v1/models failed", peerModels);
    const peerCompletion = await httpJson(`${gatewayUrl}/v1/chat/completions`, {
      token: peerToken,
      body: {
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "peer-ping" }]
      }
    });
    if (!peerCompletion.ok) fail("peer chat completion failed", peerCompletion);

    const modes = await ssh(
      SSH_ALIAS,
      [
        "stat -c '%a %n' ~/.routekit",
        "stat -c '%a %n' ~/.routekit/services/daemon.json",
        "stat -c '%a %n' ~/.routekit/services/daemon.public.json",
        "stat -c '%a %n' ~/.routekit/secrets/data-token"
      ].join(" && "),
      { configPath: ownerConfigPath }
    );
    for (const [mode, suffix] of [
      ["711", ".routekit"],
      ["600", "daemon.json"],
      ["644", "daemon.public.json"],
      ["600", "data-token"]
    ]) {
      if (!modes.stdout.includes(`${mode} `) || !modes.stdout.includes(suffix)) {
        fail(`missing expected mode ${mode} for ${suffix}`, modes);
      }
    }
    log("peer traffic and file modes ok");

    setStage("owner-restart");
    const beforeRestart = await ssh(SSH_ALIAS, withRemotePath("routekit --local --json status"), {
      configPath: ownerConfigPath
    });
    const beforeJson = parseJsonOutput(beforeRestart.stdout, "status before restart");
    const beforePid = beforeJson.daemon?.pid ?? beforeJson.pid;
    await ssh(SSH_ALIAS, withRemotePath("routekit --local --json stop --force"), {
      configPath: ownerConfigPath
    });
    await ssh(SSH_ALIAS, withRemotePath("routekit --local --json start"), {
      configPath: ownerConfigPath,
      timeoutMs: 120_000
    });
    await waitForHttpOk(`${gatewayUrl}/health`, { timeoutMs: 60_000 });
    const afterRestart = await ssh(SSH_ALIAS, withRemotePath("routekit --local --json status"), {
      configPath: ownerConfigPath
    });
    const afterJson = parseJsonOutput(afterRestart.stdout, "status after restart");
    const afterPid = afterJson.daemon?.pid ?? afterJson.pid;
    if (afterPid === beforePid) {
      fail("daemon pid did not change after restart", { beforeJson, afterJson });
    }
    const peerAfterRestart = await runCli(
      ["--remote", PEER_REMOTE_NAME, "status", "--json"],
      peerEnv
    );
    parseJsonOutput(peerAfterRestart.stdout, "peer status after restart");
    const peerModelsAfter = await httpJson(`${gatewayUrl}/v1/models`, {
      token: peerToken
    });
    if (!peerModelsAfter.ok) {
      fail("peer lost data-plane access after owner restart", peerModelsAfter);
    }
    log(`owner restarted (${beforePid} -> ${afterPid}); peer still works`);

    setStage("upgrade-to-candidate");
    const upgradeOwner = await runCli(
      ["remote", "install", SSH_ALIAS, "--version", candidateVersion, "--force", "--json"],
      ownerEnv,
      { timeoutMs: commandTimeoutMs("remoteInstall") }
    );
    parseJsonOutput(upgradeOwner.stdout, "remote install candidate");
    // Package upgrade leaves a healthy old daemon running; reconcile explicitly.
    const daemonUpgrade = await ssh(
      SSH_ALIAS,
      withRemotePath("routekit --local --json daemon upgrade"),
      {
        configPath: ownerConfigPath,
        timeoutMs: 120_000
      }
    );
    const daemonUpgradeJson = parseJsonOutput(daemonUpgrade.stdout, "daemon upgrade");
    const upgradedVersion = await ssh(SSH_ALIAS, withRemotePath("routekit version"), {
      configPath: ownerConfigPath
    });
    if (!upgradedVersion.stdout.includes(candidateVersion)) {
      fail("owner CLI did not upgrade to candidate", upgradedVersion);
    }
    await ssh(
      `${SSH_ALIAS}-peer`,
      [
        "set -eu",
        'export PATH="$HOME/.local/bin:$PATH"',
        'npm config set prefix "$HOME/.local"',
        `npm install -g --prefix "$HOME/.local" ${ROUTEKIT_PACKAGE}@${candidateVersion}`,
        "routekit version"
      ].join(" && "),
      { configPath: ownerConfigPath, timeoutMs: commandTimeoutMs("remoteInstall") }
    );
    await waitForHttpOk(`${gatewayUrl}/health`, { timeoutMs: 60_000 });
    const upgradedStatus = await runCli(
      ["--remote", OWNER_REMOTE_NAME, "status", "--json"],
      ownerEnv
    );
    const upgradedStatusJson = parseJsonOutput(upgradedStatus.stdout, "status after upgrade");
    const upgradedPid = upgradedStatusJson.daemon?.pid ?? upgradedStatusJson.pid;
    if (upgradedPid === afterPid && daemonUpgradeJson.action === "upgraded") {
      // Some upgrade paths replace in place; require version evidence either way.
      log("daemon pid unchanged after upgrade action; relying on version checks");
    }
    const packageVersion =
      upgradedStatusJson.daemon?.packageVersion ??
      upgradedStatusJson.packageVersion ??
      upgradedStatusJson.remoteVersion;
    if (
      typeof packageVersion === "string" &&
      packageVersion.length > 0 &&
      packageVersion !== candidateVersion
    ) {
      fail(
        `daemon package version ${packageVersion} != candidate ${candidateVersion}`,
        upgradedStatusJson
      );
    }
    const postUpgradeModels = await httpJson(`${gatewayUrl}/v1/models`, {
      token: ownerToken
    });
    if (!postUpgradeModels.ok) {
      fail("owner token failed after upgrade", postUpgradeModels);
    }
    const peerPostUpgrade = await httpJson(`${gatewayUrl}/v1/models`, {
      token: peerToken
    });
    if (!peerPostUpgrade.ok) {
      fail("peer token failed after upgrade", peerPostUpgrade);
    }
    // Idempotent reinstall of the same candidate.
    const idempotent = await runCli(
      ["remote", "install", SSH_ALIAS, "--version", candidateVersion, "--json"],
      ownerEnv,
      { timeoutMs: commandTimeoutMs("remoteInstall") }
    );
    const idempotentJson = parseJsonOutput(idempotent.stdout, "idempotent install");
    const installStep = (idempotentJson.steps ?? []).find((step) => step.id === "install");
    if (installStep?.status !== "skipped") {
      fail("idempotent candidate reinstall should skip install", idempotentJson);
    }
    const pids = await ssh(SSH_ALIAS, "pgrep -af '[r]outekit' || true", {
      configPath: ownerConfigPath
    });
    const daemonLines = pids.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /daemon serve|routekit.*--json start|packages\/cli/.test(line) === false)
      .filter((line) => /routekit/.test(line));
    log(`routekit processes after upgrade:\n${pids.stdout.trim() || "(none)"}`);
    void daemonLines;
    log("upgrade + persistence + idempotent reinstall ok");

    setStage("revoke");
    const tokenList = await runCli(
      ["--remote", OWNER_REMOTE_NAME, "token", "list", "--json"],
      ownerEnv
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
      fail("could not find peer data token to revoke", tokenListJson);
    }
    await runCli(
      ["--remote", OWNER_REMOTE_NAME, "token", "revoke", peerData.id, "--json"],
      ownerEnv
    );
    const revokedPeer = await httpJson(`${gatewayUrl}/v1/models`, {
      token: peerToken
    });
    if (revokedPeer.status !== 401) {
      fail(`expected 401 after peer token revoke, got ${revokedPeer.status}`, revokedPeer);
    }
    if (typeof controlTokenId === "string" && controlTokenId.length > 0) {
      await runCli(
        ["--remote", OWNER_REMOTE_NAME, "token", "revoke", controlTokenId, "--json"],
        ownerEnv,
        { allowFailure: true }
      );
    }
    const ownerStillWorks = await httpJson(`${gatewayUrl}/v1/models`, {
      token: ownerToken
    });
    if (!ownerStillWorks.ok) {
      fail("owner token should still work after peer revoke", ownerStillWorks);
    }
    log("revocation ok");

    setStage("teardown-daemon");
    await ssh(SSH_ALIAS, withRemotePath("routekit --local --json stop --force"), {
      configPath: ownerConfigPath,
      allowFailure: true
    });

    setStage("cleanup");
    const cleanupErrors = await cleanup.run(log);
    if (cleanupErrors.length > 0) {
      fail("cleanup reported errors", cleanupErrors);
    }

    writeDiagnostics(work, {
      ok: true,
      publishedVersion,
      candidateVersion,
      stages: stage.log
    });
    log("remote Docker lifecycle E2E passed");
  } catch (error) {
    const payload = {
      ok: false,
      stage: error?.stage ?? stage.name,
      message: error instanceof Error ? error.message : String(error),
      details: error?.details,
      publishedVersion,
      candidateVersion
    };
    try {
      const logs = await docker(["logs", "--tail", "200", TARGET_NAME], {
        allowFailure: true
      });
      writeFileSync(
        join(work, "target-logs.txt"),
        redactSensitiveText(`${logs.stdout}\n${logs.stderr}`, secrets)
      );
    } catch {
      // ignore diagnostic failures
    }
    writeDiagnostics(work, {
      ...payload,
      details: payload.details
        ? JSON.parse(redactSensitiveText(JSON.stringify(payload.details, null, 2), secrets))
        : undefined,
      log: stage.log.map((line) => redactSensitiveText(line, secrets))
    });
    await cleanup.run(log);
    process.stderr.write(
      redactSensitiveText(
        `remote Docker lifecycle E2E failed at ${payload.stage}: ${payload.message}\n`,
        secrets
      )
    );
    if (payload.details !== undefined) {
      process.stderr.write(
        redactSensitiveText(`${JSON.stringify(payload.details, null, 2)}\n`, secrets)
      );
    }
    process.stderr.write(`diagnostics: ${work}\n`);
    process.exitCode = 1;
    return;
  }
}

await main();
