/**
 * Helpers for the RouteKit remote Docker lifecycle E2E suite.
 *
 * Implementation is split under `./remote-docker/`:
 * - constants / process / packaging  — pure helpers (unit-tested here)
 * - docker / ssh / client            — infra adapters
 * - environment / lifecycle / runner — bootstrap + scenario stages
 *
 * Docker orchestration entrypoint: scripts/routekit-remote-docker-e2e.mjs
 */
export {
  NETWORK,
  OWNER_REMOTE_NAME,
  OWNER_USER,
  PEER_REMOTE_NAME,
  PEER_USER,
  REGISTRY_NAME,
  ROUTEKIT_PACKAGE,
  ROUTEKIT_SCOPE,
  SSH_ALIAS,
  TARGET_IMAGE,
  TARGET_NAME
} from "./remote-docker/constants.mjs";

export {
  CleanupStack,
  commandTimeoutMs,
  createStageLogger,
  ensureEmptyDir,
  freePort,
  parseJsonOutput,
  redactSensitiveText,
  requireBinary,
  runCaptured,
  waitForHttpOk
} from "./remote-docker/process.mjs";

export {
  assertCandidateClosureComplete,
  candidateVersionFor,
  collectPackageClosure,
  isInstallableVersion,
  packCandidateArtifacts,
  publishCandidateArtifacts,
  registerVerdaccioUser,
  resolveLatestPublishedVersion,
  rewriteManifestForCandidate
} from "./remote-docker/packaging.mjs";

export {
  privateCliInstallCommand,
  withRemotePath,
  writeSshConfig,
  writeSshWrapper
} from "./remote-docker/ssh.mjs";

export { createDockerClient } from "./remote-docker/docker.mjs";

export {
  createClientEnv,
  createRoutekitCli,
  createSshRunner,
  httpJson,
  openLocalForwardTunnel
} from "./remote-docker/client.mjs";

export {
  assertChatCompletionOk,
  assertModelsOk,
  assertOwnerStateModes,
  assertRemoteCliVersion,
  requireDaemonPid
} from "./remote-docker/assertions.mjs";

export { runRemoteDockerLifecycle } from "./remote-docker/runner.mjs";

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function modeBits(mode) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

export function assertMode(path, expected) {
  const mode = modeBits(statSync(path).mode);
  if (mode !== expected) {
    throw new Error(`${path} mode is ${mode}, expected ${expected}`);
  }
}

export function workspaceRootFromModuleUrl(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}
