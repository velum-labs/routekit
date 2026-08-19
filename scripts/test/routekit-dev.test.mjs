import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCorepackPnpmEnvironment } from "../lib/corepack-pnpm.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDirectory, "..", "..");
const routekitDev = resolve(repoRoot, "scripts", "routekit-dev.mjs");
const linkRoutekitDev = resolve(repoRoot, "scripts", "link-routekit-dev.mjs");

function writeExecutable(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

test("the pinned pnpm environment routes child pnpm calls through Corepack", () => {
  if (process.platform === "win32") return;

  const directory = mkdtempSync(join(tmpdir(), "routekit-dev-test-"));
  const logPath = join(directory, "calls.log");
  const fakeBin = join(directory, "bin");
  mkdirSync(fakeBin);

  writeExecutable(
    join(fakeBin, "corepack"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${logPath}'
`
  );
  writeExecutable(
    join(fakeBin, "pnpm"),
    `#!/bin/sh
printf '%s\\n' "unmanaged pnpm was invoked" >> '${logPath}'
exit 91
`
  );

  const pinned = createCorepackPnpmEnvironment({
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`
  });

  try {
    const result = spawnSync("pnpm", ["run", "build"], {
      encoding: "utf8",
      env: pinned.environment
    });

    assert.equal(result.status, 0);
    assert.equal(readFileSync(logPath, "utf8"), "pnpm run build\n");
  } finally {
    pinned.dispose();
  }
});

test("routekit-dev requests the dependency-aware CLI build before launch", () => {
  if (process.platform === "win32") return;

  const directory = mkdtempSync(join(tmpdir(), "routekit-dev-test-"));
  const logPath = join(directory, "calls.log");
  const fakeBin = join(directory, "bin");
  mkdirSync(fakeBin);

  writeExecutable(
    join(fakeBin, "corepack"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${logPath}'
`
  );

  const result = spawnSync(process.execPath, [routekitDev, "--version"], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@velum-labs\/routekit \d+\.\d+\.\d+/u);
  assert.equal(readFileSync(logPath, "utf8"), `pnpm --dir ${repoRoot} run build:cli\n`);
});

test("the linker uses pinned pnpm and ignores Corepack warning lines", () => {
  if (process.platform === "win32") return;

  const directory = mkdtempSync(join(tmpdir(), "routekit-dev-test-"));
  const globalBin = join(directory, "global-bin");
  const fakeBin = join(directory, "bin");
  mkdirSync(fakeBin);
  mkdirSync(globalBin);

  writeExecutable(
    join(fakeBin, "corepack"),
    `#!/bin/sh
printf '%s\\n' '[WARN] test warning'
printf '%s\\n' '${globalBin}'
`
  );
  writeExecutable(
    join(fakeBin, "pnpm"),
    `#!/bin/sh
exit 91
`
  );

  const result = spawnSync(process.execPath, [linkRoutekitDev, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`would write ${globalBin}/routekit-dev`, "u"));
  assert.match(result.stdout, new RegExp(`global pnpm bin directory: ${globalBin}`, "u"));
});

test("the linker updates stale generated shims from older pnpm global-bin layouts", () => {
  if (process.platform === "win32") return;

  const directory = mkdtempSync(join(tmpdir(), "routekit-dev-test-"));
  const currentGlobalBin = join(directory, "current-bin");
  const legacyGlobalBin = join(directory, "legacy-bin");
  const fakeBin = join(directory, "fake-bin");
  mkdirSync(currentGlobalBin);
  mkdirSync(legacyGlobalBin);
  mkdirSync(fakeBin);

  writeExecutable(
    join(fakeBin, "corepack"),
    `#!/bin/sh
printf '%s\\n' '${currentGlobalBin}'
`
  );
  writeExecutable(
    join(legacyGlobalBin, "routekit-dev"),
    `#!/bin/sh
exec node '/old/checkout/scripts/routekit-dev.mjs' "$@"
`
  );

  const result = spawnSync(process.execPath, [linkRoutekitDev], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [fakeBin, currentGlobalBin, legacyGlobalBin, "/usr/bin", "/bin"].join(delimiter)
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const currentShim = readFileSync(join(currentGlobalBin, "routekit-dev"), "utf8");
  const legacyShim = readFileSync(join(legacyGlobalBin, "routekit-dev"), "utf8");
  assert.equal(currentShim, legacyShim);
  assert.ok(currentShim.includes(routekitDev));
  assert.match(result.stdout, /updated stale routekit-dev shim/u);
});
