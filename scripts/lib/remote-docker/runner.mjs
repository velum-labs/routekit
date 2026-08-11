/**
 * Composition of infrastructure + lifecycle stages for the remote Docker E2E.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createRoutekitCli, createSshRunner } from "./client.mjs";
import { TARGET_NAME } from "./constants.mjs";
import { createDockerClient } from "./docker.mjs";
import {
  buildAndStartTarget,
  prepareClientHomes,
  resolveAndPackCandidates,
  startRegistryAndPublish
} from "./environment.mjs";
import {
  enrollOwner,
  enrollPeer,
  installOwner,
  installPeerCli,
  openGatewayTunnel,
  restartOwner,
  revokePeer,
  runOwnerTraffic,
  runPeerTraffic,
  teardownDaemon,
  upgradeToCandidate
} from "./lifecycle.mjs";
import {
  CleanupStack,
  createStageLogger,
  ensureEmptyDir,
  redactSensitiveText,
  requireBinary
} from "./process.mjs";

/**
 * @param {{
 *   root: string;
 *   harnessDir: string;
 *   cliEntry: string;
 *   artifactRoot: string;
 *   runId: string;
 * }} options
 */
export async function runRemoteDockerLifecycle(options) {
  const { root, harnessDir, cliEntry, artifactRoot, runId } = options;
  const stage = createStageLogger();
  const { setStage, log, fail } = stage;

  requireBinary("docker");
  requireBinary("ssh");
  requireBinary("ssh-keygen");
  requireBinary("pnpm");
  requireBinary("npm");
  requireBinary("tar");

  if (!existsSync(cliEntry)) {
    fail(`built CLI missing at ${cliEntry}; run \`pnpm build\` (or \`pnpm build:cli\`) first`);
  }

  const cleanup = new CleanupStack();
  const workDir = ensureEmptyDir(join(artifactRoot, runId));
  const secrets = [];
  /** @type {string | undefined} */
  let initialVersion;
  /** @type {string | undefined} */
  let candidateVersion;
  const docker = createDockerClient({ fail });
  const runCli = createRoutekitCli({ root, cliEntry, fail });
  const ssh = createSshRunner({ fail });

  const writeDiagnostics = (dir, payload) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), `${JSON.stringify(payload, null, 2)}\n`);
    writeFileSync(join(dir, "log.txt"), `${stage.lines.join("\n")}\n`);
  };

  try {
    const ctxBase = {
      root,
      harnessDir,
      workDir,
      runId,
      docker,
      cleanup,
      log,
      fail,
      setStage,
      secrets,
      ssh
    };

    const versions = await resolveAndPackCandidates(ctxBase);
    initialVersion = versions.initialVersion;
    candidateVersion = versions.candidateVersion;

    const registry = await startRegistryAndPublish({
      ...ctxBase,
      initialPackages: versions.initialPackages,
      candidatePackages: versions.candidatePackages
    });

    const target = await buildAndStartTarget({
      ...ctxBase,
      registryUrlInDocker: registry.registryUrlInDocker
    });

    const clients = await prepareClientHomes({
      ...ctxBase,
      sshPort: target.sshPort,
      identityFile: target.identityFile
    });

    const lifecycleCtx = {
      runCli,
      ssh,
      log,
      fail,
      setStage,
      secrets,
      cleanup,
      ownerEnv: clients.ownerEnv,
      peerEnv: clients.peerEnv,
      ownerConfigPath: clients.ownerConfigPath,
      ownerState: clients.ownerState,
      peerState: clients.peerState,
      initialVersion,
      candidateVersion
    };

    await installOwner(lifecycleCtx);
    const tunnel = await openGatewayTunnel(lifecycleCtx);
    const { ownerToken } = await enrollOwner({
      ...lifecycleCtx,
      gatewayUrl: tunnel.gatewayUrl
    });
    const { ownerPid } = await runOwnerTraffic({
      ...lifecycleCtx,
      gatewayUrl: tunnel.gatewayUrl,
      ownerToken
    });
    await installPeerCli(lifecycleCtx);
    const { peerToken, controlTokenId } = await enrollPeer({
      ...lifecycleCtx,
      gatewayUrl: tunnel.gatewayUrl
    });
    await runPeerTraffic({
      ...lifecycleCtx,
      gatewayUrl: tunnel.gatewayUrl,
      peerToken,
      ownerPid
    });
    const { afterPid } = await restartOwner({
      ...lifecycleCtx,
      gatewayUrl: tunnel.gatewayUrl,
      peerToken
    });
    await upgradeToCandidate({
      ...lifecycleCtx,
      gatewayUrl: tunnel.gatewayUrl,
      ownerToken,
      peerToken,
      afterPid
    });
    await revokePeer({
      ...lifecycleCtx,
      gatewayUrl: tunnel.gatewayUrl,
      ownerToken,
      peerToken,
      controlTokenId
    });
    await teardownDaemon(lifecycleCtx);

    setStage("cleanup");
    const cleanupErrors = await cleanup.run(log);
    if (cleanupErrors.length > 0) {
      fail("cleanup reported errors", cleanupErrors);
    }

    writeDiagnostics(workDir, {
      ok: true,
      initialVersion,
      candidateVersion,
      stages: stage.lines
    });
    log("remote Docker lifecycle E2E passed");
    return { ok: true, workDir, initialVersion, candidateVersion };
  } catch (error) {
    const payload = {
      ok: false,
      stage: error?.stage ?? stage.name,
      message: error instanceof Error ? error.message : String(error),
      details: error?.details,
      initialVersion,
      candidateVersion
    };
    try {
      const logs = await docker.run(["logs", "--tail", "200", TARGET_NAME], {
        allowFailure: true
      });
      writeFileSync(
        join(workDir, "target-logs.txt"),
        redactSensitiveText(`${logs.stdout}\n${logs.stderr}`, secrets)
      );
    } catch {
      // ignore diagnostic failures
    }
    writeDiagnostics(workDir, {
      ...payload,
      details: payload.details
        ? JSON.parse(redactSensitiveText(JSON.stringify(payload.details, null, 2), secrets))
        : undefined,
      log: stage.lines.map((line) => redactSensitiveText(line, secrets))
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
    process.stderr.write(`diagnostics: ${workDir}\n`);
    process.exitCode = 1;
    return { ok: false, workDir, initialVersion, candidateVersion };
  }
}
