import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveEvalNodeExecPath } from "../adapters/eval-node-runtime.js";

test("qualification selects the installed supported runtime when its launcher Node is too old", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-node-runtime-"));
  const runtime = path.join(
    home,
    ".local",
    "share",
    "routekit",
    "node",
    "node-v22.22.2-linux-x64",
    "bin",
    "node"
  );
  await mkdir(path.dirname(runtime), { recursive: true });
  await symlink(process.execPath, runtime);
  try {
    assert.equal(
      resolveEvalNodeExecPath({
        architecture: "x64",
        currentExecPath: "/usr/bin/node",
        currentVersion: "20.19.5",
        env: {
          HOME: home,
          PATH: "/missing"
        },
        platform: "linux"
      }),
      runtime
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("qualification refuses an unsupported launcher when no supported runtime exists", () => {
  assert.throws(
    () =>
      resolveEvalNodeExecPath({
        architecture: process.arch,
        currentExecPath: "/missing/node",
        currentVersion: "20.19.5",
        env: {
          HOME: "/missing",
          PATH: "/missing"
        },
        platform: "win32"
      }),
    /requires Node >= 22\.22\.0/u
  );
});
