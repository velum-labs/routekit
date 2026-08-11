#!/usr/bin/env node
/**
 * RouteKit remote Docker lifecycle E2E — composition root.
 *
 * Host runner = single client machine (built candidate CLI).
 * Docker target = Linux SSH host with owner + peer Unix accounts.
 * Verdaccio = local registry hosting two candidate prereleases built from the
 * same clean-break protocol: an initial install and its upgrade target.
 *
 * Proves: remote install → multi-user peer enrollment → traffic → upgrade →
 * persistence → revocation → teardown.
 *
 * Implementation lives under scripts/lib/remote-docker/.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runRemoteDockerLifecycle } from "./lib/remote-docker/runner.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS_DIR = join(ROOT, "test/docker/remote-lifecycle");
const CLI_ENTRY = join(ROOT, "packages/cli/dist/index.js");
const ARTIFACT_ROOT = join(ROOT, ".artifacts/remote-docker");
const RUN_ID = `${Date.now().toString(36)}${process.pid.toString(36)}`;

await runRemoteDockerLifecycle({
  root: ROOT,
  harnessDir: HARNESS_DIR,
  cliEntry: CLI_ENTRY,
  artifactRoot: ARTIFACT_ROOT,
  runId: RUN_ID
});
