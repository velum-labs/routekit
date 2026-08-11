/**
 * Infrastructure bootstrap for the remote Docker lifecycle suite:
 * workdir, Verdaccio, SSH keys, target container, client homes, gateway tunnel.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClientEnv } from "./client.mjs";
import {
  MOCK_MODEL,
  NETWORK,
  OWNER_USER,
  PEER_USER,
  REGISTRY_NAME,
  SSH_ALIAS,
  TARGET_IMAGE,
  TARGET_NAME
} from "./constants.mjs";
import {
  assertCandidateClosureComplete,
  candidateVersionFor,
  packCandidateArtifacts,
  publishCandidateArtifacts,
  registerVerdaccioUser,
  resolveLatestPublishedVersion
} from "./packaging.mjs";
import { freePort, waitForHttpOk } from "./process.mjs";
import { writeSshConfig, writeSshWrapper } from "./ssh.mjs";

/**
 * @param {{
 *   root: string;
 *   harnessDir: string;
 *   workDir: string;
 *   runId: string;
 *   docker: { run: Function };
 *   cleanup: { add: Function };
 *   log: (message: string) => void;
 *   fail: (message: string, details?: unknown) => never;
 *   setStage: (name: string) => void;
 *   secrets: string[];
 * }} ctx
 */
export async function resolveAndPackCandidates(ctx) {
  ctx.setStage("resolve-versions");
  const publishedVersion = resolveLatestPublishedVersion();
  const initialVersion = candidateVersionFor(publishedVersion, `${ctx.runId}.initial`);
  const candidateVersion = candidateVersionFor(publishedVersion, `${ctx.runId}.upgrade`);
  ctx.log(`published version seed: ${publishedVersion}`);
  ctx.log(`initial candidate: ${initialVersion}`);
  ctx.log(`upgrade candidate: ${candidateVersion}`);

  ctx.setStage("pack-candidates");
  const initialPackages = packCandidateArtifacts(
    ctx.root,
    initialVersion,
    join(ctx.workDir, "initial-pack")
  );
  ctx.log(`packed ${initialPackages.length} packages for ${initialVersion}`);
  assertCandidateClosureComplete(initialPackages, initialVersion);
  const candidatePackages = packCandidateArtifacts(
    ctx.root,
    candidateVersion,
    join(ctx.workDir, "upgrade-pack")
  );
  ctx.log(`packed ${candidatePackages.length} packages for ${candidateVersion}`);
  assertCandidateClosureComplete(candidatePackages, candidateVersion);

  return {
    publishedVersion,
    initialVersion,
    candidateVersion,
    initialPackages,
    candidatePackages
  };
}

/**
 * @param {Parameters<typeof resolveAndPackCandidates>[0] & {
 *   initialPackages: unknown[];
 *   candidatePackages: unknown[];
 * }} ctx
 */
export async function startRegistryAndPublish(ctx) {
  ctx.setStage("start-registry");
  const registryPort = await freePort();
  const registryStorage = join(ctx.workDir, "verdaccio-storage");
  mkdirSync(registryStorage, { recursive: true });
  // Verdaccio runs as uid 10001; allow it to write the bind-mounted storage.
  chmodSync(registryStorage, 0o777);

  await ctx.docker
    .run(["network", "inspect", NETWORK], { allowFailure: true })
    .then(async (result) => {
      if (result.code !== 0) {
        await ctx.docker.run(["network", "create", NETWORK]);
      }
    });
  ctx.cleanup.add("remove docker network", async () => {
    await ctx.docker.run(["network", "rm", NETWORK], { allowFailure: true });
  });

  await ctx.docker.run(["rm", "-f", REGISTRY_NAME], { allowFailure: true });
  await ctx.docker.run([
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
    `${join(ctx.harnessDir, "verdaccio.yaml")}:/verdaccio/conf/config.yaml:ro`,
    "-v",
    `${registryStorage}:/verdaccio/storage`,
    "verdaccio/verdaccio:6"
  ]);
  ctx.cleanup.add("remove registry container", async () => {
    await ctx.docker.run(["rm", "-f", REGISTRY_NAME], { allowFailure: true });
  });

  const registryUrl = `http://127.0.0.1:${registryPort}/`;
  const registryUrlInDocker = "http://verdaccio:4873/";
  await waitForHttpOk(`${registryUrl}-/ping`, { timeoutMs: 60_000 });
  ctx.log(`verdaccio ready at ${registryUrl}`);

  ctx.setStage("publish-candidates");
  const registryAuth = await registerVerdaccioUser(registryUrl);
  ctx.secrets.push(registryAuth.token, registryAuth.password);
  const initialPublished = await publishCandidateArtifacts(ctx.initialPackages, registryUrl, {
    token: registryAuth.token
  });
  const candidatePublished = await publishCandidateArtifacts(ctx.candidatePackages, registryUrl, {
    token: registryAuth.token
  });
  ctx.log(
    `published ${initialPublished.length} initial and ${candidatePublished.length} upgrade packages`
  );

  return { registryPort, registryUrl, registryUrlInDocker };
}

/**
 * @param {Parameters<typeof resolveAndPackCandidates>[0] & {
 *   registryUrlInDocker: string;
 * }} ctx
 */
export async function buildAndStartTarget(ctx) {
  ctx.setStage("prepare-ssh-keys");
  const keyDir = join(ctx.workDir, "ssh");
  mkdirSync(keyDir, { recursive: true });
  const identityFile = join(keyDir, "id_ed25519");
  execFileSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-f", identityFile, "-C", "routekit-remote-docker-e2e"],
    { stdio: "pipe" }
  );
  chmodSync(identityFile, 0o600);
  const authorizedKeys = join(keyDir, "authorized_keys");
  copyFileSync(`${identityFile}.pub`, authorizedKeys);

  ctx.setStage("build-target");
  await ctx.docker.run(["build", "-t", TARGET_IMAGE, ctx.harnessDir], {
    timeoutMs: 300_000
  });

  ctx.setStage("start-target");
  const sshPort = await freePort();
  await ctx.docker.run(["rm", "-f", TARGET_NAME], { allowFailure: true });
  await ctx.docker.run([
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
    `REGISTRY_URL=${ctx.registryUrlInDocker}`,
    "-e",
    "OPENAI_API_KEY=docker-e2e-key",
    "-e",
    "OPENAI_BASE_URL=http://127.0.0.1:17999/v1",
    "-e",
    "MOCK_PROVIDER_PORT=17999",
    "-e",
    `MOCK_PROVIDER_MODEL=${MOCK_MODEL}`,
    "-v",
    `${authorizedKeys}:/keys/authorized_keys:ro`,
    TARGET_IMAGE
  ]);
  ctx.cleanup.add("remove target container", async () => {
    await ctx.docker.run(["rm", "-f", TARGET_NAME], { allowFailure: true });
  });

  return { identityFile, sshPort };
}

/**
 * @param {Parameters<typeof resolveAndPackCandidates>[0] & {
 *   sshPort: number;
 *   identityFile: string;
 *   ssh: Function;
 * }} ctx
 */
export async function prepareClientHomes(ctx) {
  const ownerHome = mkdtempSync(join(tmpdir(), "rk-docker-owner-client-"));
  const peerClientHome = mkdtempSync(join(tmpdir(), "rk-docker-peer-client-"));
  ctx.cleanup.add("remove owner client home", async () => {
    rmSync(ownerHome, { recursive: true, force: true });
  });
  ctx.cleanup.add("remove peer client home", async () => {
    rmSync(peerClientHome, { recursive: true, force: true });
  });

  const ownerState = join(ownerHome, ".routekit");
  const peerState = join(peerClientHome, ".routekit");
  mkdirSync(ownerState, { recursive: true });
  mkdirSync(peerState, { recursive: true });

  const ownerConfigPath = join(ownerHome, "ssh-config");
  const peerConfigPath = join(peerClientHome, "ssh-config");
  writeSshConfig(ownerConfigPath, {
    hosts: [
      {
        alias: SSH_ALIAS,
        host: "127.0.0.1",
        port: ctx.sshPort,
        user: OWNER_USER,
        identityFile: ctx.identityFile
      },
      {
        alias: `${SSH_ALIAS}-peer`,
        host: "127.0.0.1",
        port: ctx.sshPort,
        user: PEER_USER,
        identityFile: ctx.identityFile
      }
    ]
  });
  copyFileSync(ownerConfigPath, peerConfigPath);
  chmodSync(peerConfigPath, 0o600);

  ctx.setStage("wait-ssh");
  const sshDeadline = Date.now() + 60_000;
  let sshReady = false;
  while (Date.now() < sshDeadline) {
    const probe = await ctx.ssh(
      SSH_ALIAS,
      "printf ready && uname -s && id -un && command -v routekit >/dev/null; printf ' routekit=%s' $?",
      { configPath: ownerConfigPath, allowFailure: true, timeoutMs: 10_000 }
    );
    if (probe.code === 0 && probe.stdout.includes("ready")) {
      sshReady = true;
      ctx.log(`ssh ready: ${probe.stdout.trim()}`);
      if (!probe.stdout.includes("routekit=1")) {
        ctx.fail("target unexpectedly already has routekit on PATH", probe);
      }
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  if (!sshReady) ctx.fail("SSH to target never became ready");

  const binDir = join(ctx.workDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeSshWrapper(join(binDir, "ssh"), ownerConfigPath);

  const peerBinDir = join(ctx.workDir, "peer-bin");
  mkdirSync(peerBinDir, { recursive: true });
  writeSshWrapper(join(peerBinDir, "ssh"), peerConfigPath);

  const ownerEnv = {
    ...createClientEnv(ownerHome, ownerState),
    GIT_SSH_COMMAND: `ssh -F ${ownerConfigPath}`,
    PATH: `${binDir}:${process.env.PATH}`
  };
  const peerEnv = {
    ...createClientEnv(peerClientHome, peerState),
    PATH: `${peerBinDir}:${process.env.PATH}`
  };

  return {
    ownerHome,
    peerClientHome,
    ownerState,
    peerState,
    ownerConfigPath,
    peerConfigPath,
    ownerEnv,
    peerEnv
  };
}
