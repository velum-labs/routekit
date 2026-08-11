import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  type CommandResult,
  type CommandRunner,
  inspectSelfUpdateInstallation as inspectSelfUpdateInstallationRaw,
  type InspectOptions,
  performSelfUpdate as performSelfUpdateRaw,
  remediationCommand,
  SelfUpdateInspectionError
} from "../self-update-inspector.js";
import {
  packageManifest,
  packageRootFromEntry,
  shimTarget
} from "../self-update/candidate.js";
import { defaultRunner } from "../self-update/runner.js";
import { acquireSelfUpdateLock } from "../self-update/lock.js";
import { detectExternalOwner } from "../self-update/adapters/external.js";

type ManagerKind = "npm" | "pnpm";

type Fixture = {
  home: string;
  bin: string;
  prefix: string;
  root: string;
  packageRoot: string;
  packageJson: string;
  entry: string;
  path: string;
  manager: string;
  listedPackageRoot?: string;
};

type RunnerBehavior = {
  /** When set, `routekit version` reports this instead of the package.json version. */
  reportedVersion?: string;
  /** When true, install/add succeeds but leaves the package tree unchanged. */
  staleInstall?: boolean;
  /** When set, a pnpm update must preserve this PNPM_HOME value. */
  expectedPnpmHome?: string;
  /** Exact version returned by manager-native metadata queries. */
  metadataVersion?: string;
  /** Manager-native metadata query failure text. */
  metadataError?: string;
};

function currentProtocolOptions(options: InspectOptions): InspectOptions {
  const original = options.runner ?? defaultRunner;
  const runner: CommandRunner = async (executable, args, env, runOptions) => {
    const result = await original(executable, args, env, runOptions);
    if (args[0] !== "__self-inspect" || result.exitCode === 0) {
      return result;
    }
    let candidateRoot: string | undefined;
    try {
      candidateRoot = packageRootFromEntry(shimTarget(executable));
    } catch {
      return result;
    }
    if (candidateRoot === undefined) return result;
    const manifest = packageManifest(candidateRoot);
    if (typeof manifest?.version !== "string") return result;
    const entry = (() => {
      try {
        return shimTarget(executable);
      } catch {
        return undefined;
      }
    })();
    if (entry === undefined) return result;
    return {
      stdout: `${JSON.stringify({
        schemaVersion: 1,
        packageName: "@velum-labs/routekit",
        packageRoot: candidateRoot,
        entry,
        version: manifest.version,
        processExecPath: options.processExecPath ?? process.execPath
      })}\n`,
      stderr: "",
      exitCode: 0
    };
  };
  return { ...options, runner };
}

async function inspectSelfUpdateInstallation(
  requestedVersion: string,
  options: InspectOptions
) {
  return await inspectSelfUpdateInstallationRaw(
    requestedVersion,
    currentProtocolOptions(options)
  );
}

async function performSelfUpdate(
  requestedVersion: string,
  dryRun: boolean,
  options: InspectOptions
) {
  return await performSelfUpdateRaw(
    requestedVersion,
    dryRun,
    currentProtocolOptions(options)
  );
}

function touchExecutable(path: string): void {
  writeFileSync(path, "");
  chmodSync(path, 0o755);
}

function readPackageVersion(packageJson: string): string {
  return (JSON.parse(readFileSync(packageJson, "utf8")) as { version: string }).version;
}

function writePackageVersion(packageJson: string, version: string): void {
  const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as {
    name: string;
    version: string;
  };
  writeFileSync(packageJson, JSON.stringify({ ...manifest, version }));
}

function writePnpmShim(path: string, entry: string): void {
  writeFileSync(path, `#!/bin/sh\nexec node "${entry}" "$@"\n# cmd-shim-target=${entry}\n`);
  chmodSync(path, 0o755);
}

function fixture(kind: ManagerKind, version = "1.0.0", suffix = ""): Fixture {
  const home = mkdtempSync(join(tmpdir(), `routekit-self-update-${kind}-`));
  const prefix = join(home, suffix || "global");
  const bin = kind === "npm" ? join(prefix, "bin") : join(home, "pnpm-bin");
  const root =
    kind === "npm"
      ? join(prefix, "lib", "node_modules")
      : join(home, suffix || "pnpm-global", "5", "node_modules");
  const packageRoot = join(root, "@velum-labs", "routekit");
  const packageJson = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(packageJson, JSON.stringify({ name: "@velum-labs/routekit", version }));
  writeFileSync(entry, "");
  symlinkSync(entry, join(bin, "routekit"));
  const manager = join(bin, kind);
  touchExecutable(manager);
  return { home, bin, prefix, root, packageRoot, packageJson, entry, path: bin, manager };
}

function pnpmV11Fixture(version = "1.0.0"): Fixture {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-pnpm-v11-"));
  const prefix = join(home, "pnpm");
  const bin = join(prefix, "bin");
  const root = join(prefix, "global", "v11");
  const project = join(root, "a876-fixture");
  const packageRoot = join(project, "node_modules", "@velum-labs", "routekit");
  const storePackageRoot = join(
    prefix,
    "store",
    "v11",
    "links",
    "@velum-labs",
    "routekit",
    version,
    "fixture",
    "node_modules",
    "@velum-labs",
    "routekit"
  );
  const packageJson = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(dirname(join(storePackageRoot, "dist", "index.js")), { recursive: true });
  mkdirSync(dirname(packageRoot), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(storePackageRoot, "package.json"),
    JSON.stringify({ name: "@velum-labs/routekit", version })
  );
  writeFileSync(join(storePackageRoot, "dist", "index.js"), "");
  symlinkSync(storePackageRoot, packageRoot);
  const routekit = join(bin, "routekit");
  writePnpmShim(routekit, entry);
  const manager = join(bin, "pnpm");
  touchExecutable(manager);
  return {
    home,
    bin,
    prefix,
    root,
    packageRoot,
    packageJson,
    entry,
    path: bin,
    manager,
    listedPackageRoot: packageRoot
  };
}

function relocatePnpmV11Package(value: Fixture, version: string): void {
  const packageRoot = join(
    value.root,
    `updated-${version}`,
    "node_modules",
    "@velum-labs",
    "routekit"
  );
  const storePackageRoot = join(
    value.prefix,
    "store",
    "v11",
    "links",
    "@velum-labs",
    "routekit",
    version,
    "updated",
    "node_modules",
    "@velum-labs",
    "routekit"
  );
  const packageJson = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(dirname(join(storePackageRoot, "dist", "index.js")), { recursive: true });
  mkdirSync(dirname(packageRoot), { recursive: true });
  writeFileSync(
    join(storePackageRoot, "package.json"),
    JSON.stringify({ name: "@velum-labs/routekit", version })
  );
  writeFileSync(join(storePackageRoot, "dist", "index.js"), "");
  symlinkSync(storePackageRoot, packageRoot);
  writePnpmShim(join(value.bin, "routekit"), entry);
  value.packageRoot = packageRoot;
  value.packageJson = packageJson;
  value.entry = entry;
  value.listedPackageRoot = packageRoot;
}

function createRunner(value: Fixture, behavior: RunnerBehavior = {}): CommandRunner {
  return async (executable, args, env): Promise<CommandResult> => {
    const name = basename(executable);
    const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
    const fail = (exitCode = 2): CommandResult => ({ stdout: "", stderr: "", exitCode });

    if (name === "routekit" && args[0] === "version") {
      const version = behavior.reportedVersion ?? readPackageVersion(value.packageJson);
      return ok(`@velum-labs/routekit ${version}\n`);
    }

    if (name === "npm" && executable === value.manager) {
      if (args[0] === "prefix" && args[1] === "-g") return ok(`${value.prefix}\n`);
      if (args[0] === "root" && args[1] === "-g") return ok(`${value.root}\n`);
      if (args[0] === "ls" && args[1] === "-g")
        return ok(
          JSON.stringify({
            dependencies: {
              "@velum-labs/routekit": {
                path: value.packageRoot,
                version: readPackageVersion(value.packageJson)
              }
            }
          })
        );
      if (args[0] === "view") {
        if (behavior.metadataError !== undefined)
          return { stdout: "", stderr: behavior.metadataError, exitCode: 1 };
        return ok(JSON.stringify(behavior.metadataVersion ?? readPackageVersion(value.packageJson)));
      }
      if (args[0] === "install") {
        if (behavior.staleInstall === true) return ok("");
        const requested = args.at(-1)?.split("@").at(-1) ?? "";
        writePackageVersion(value.packageJson, requested);
        return ok("");
      }
      return fail();
    }

    if (name === "pnpm" && executable === value.manager) {
      if (args[0] === "bin" && args[1] === "-g") return ok(`${value.bin}\n`);
      if (args[0] === "root" && args[1] === "-g") return ok(`${value.root}\n`);
      if (args[0] === "list" && args[1] === "-g") {
        return ok(`${value.root}\n${value.listedPackageRoot ?? value.packageRoot}\n`);
      }
      if (args[0] === "view") {
        if (behavior.metadataError !== undefined)
          return { stdout: "", stderr: behavior.metadataError, exitCode: 1 };
        return ok(JSON.stringify(behavior.metadataVersion ?? readPackageVersion(value.packageJson)));
      }
      if (args[0] === "add") {
        if (
          behavior.expectedPnpmHome !== undefined &&
          env.PNPM_HOME !== behavior.expectedPnpmHome
        )
          return fail();
        if (behavior.staleInstall === true) return ok("");
        const requested =
          args.find((arg) => arg.startsWith("@velum-labs/routekit@"))?.split("@").at(-1) ?? "";
        if (value.listedPackageRoot === undefined) writePackageVersion(value.packageJson, requested);
        else relocatePnpmV11Package(value, requested);
        return ok("");
      }
      return fail();
    }

    return fail(127);
  };
}

function createCompositeRunner(
  values: readonly Fixture[],
  behavior: RunnerBehavior = {}
): CommandRunner {
  return async (executable, args, env) => {
    const value = values.find((candidate) => executable.startsWith(candidate.bin));
    if (value === undefined) return { stdout: "", stderr: "", exitCode: 127 };
    return await createRunner(value, behavior)(executable, args, env);
  };
}

function options(value: Fixture, behavior: RunnerBehavior = {}) {
  return {
    path: value.path,
    env: { PATH: value.path },
    executingEntry: value.entry,
    runner: createRunner(value, behavior)
  };
}

test("npm global owner is selected and a fresh PATH executable proves the update", async () => {
  const value = fixture("npm");
  const result = await performSelfUpdate("2.0.0", false, options(value));
  assert.equal(result.action, "updated");
  assert.equal(result.from, "1.0.0");
  assert.equal(result.to, "2.0.0");
  assert.equal(result.owner.kind, "npm");
  assert.deepEqual(result.command.slice(1, 8), [
    "install",
    "-g",
    "--force",
    "--no-audit",
    "--no-fund",
    "--prefix",
    join(value.home, "global")
  ]);
});

test("pnpm global owner supports versioned global roots", async () => {
  for (const suffix of ["pnpm-v3", "pnpm-v10"]) {
    const value = fixture("pnpm", "1.0.0", suffix);
    const result = await performSelfUpdate("latest", false, {
      ...options(value, { metadataVersion: "2.1.0" })
    });
    assert.equal(result.owner.kind, "pnpm");
    assert.equal(result.owner.globalRoot, join(value.home, suffix, "5", "node_modules"));
    assert.equal(result.to, "2.1.0");
    assert.equal(result.version, "latest");
    assert.equal(result.targetVersion, "2.1.0");
  assert.deepEqual(result.command.slice(1), [
    "add",
    "-g",
    "@velum-labs/routekit@2.1.0",
    "--config.minimum-release-age=0"
  ]);
  }
});

test("ENG-734: pnpm 11 hashed global install is matched through the listed package path", async () => {
  const value = pnpmV11Fixture();
  const oldPackageJson = value.packageJson;
  const alternateBin = join(value.home, "alternate-bin");
  mkdirSync(alternateBin, { recursive: true });
  const alternateManager = join(alternateBin, "pnpm");
  touchExecutable(alternateManager);
  const path = `${value.bin}:${alternateBin}`;
  const runner = createRunner(value, { expectedPnpmHome: value.prefix });
  const result = await performSelfUpdate("2.0.0", false, {
    path,
    env: { PATH: path, PNPM_HOME: value.prefix },
    executingEntry: value.entry,
    runner
  });
  assert.equal(result.action, "updated");
  assert.equal(result.from, "1.0.0");
  assert.equal(result.to, "2.0.0");
  assert.equal(result.owner.kind, "pnpm");
  assert.equal(result.owner.executable, value.manager);
  assert.equal(result.owner.globalRoot, value.root);
  assert.deepEqual(result.command, [
    value.manager,
    "add",
    "-g",
    "@velum-labs/routekit@2.0.0",
    "--config.minimum-release-age=0"
  ]);
  assert.equal(
    result.diagnostics.filter((line) => line.startsWith("package manager ")).length,
    1
  );
  assert.equal(readPackageVersion(oldPackageJson), "1.0.0");
  assert.equal(readPackageVersion(value.packageJson), "2.0.0");
});

for (const activeKind of ["npm", "pnpm"] as const) {
  test(`${activeKind} active first updates while a lower-priority install remains untouched`, async () => {
    const active = fixture(activeKind, "1.0.0");
    const secondary = fixture(activeKind === "npm" ? "pnpm" : "npm", "9.0.0");
    const path = `${active.bin}:${secondary.bin}`;
    const result = await performSelfUpdate("2.0.0", false, {
      path,
      env: { PATH: path },
      executingEntry: active.entry,
      runner: createCompositeRunner([active, secondary])
    });
    assert.equal(result.action, "updated");
    assert.equal(result.owner.kind, activeKind);
    assert.equal(readPackageVersion(active.packageJson), "2.0.0");
    assert.equal(readPackageVersion(secondary.packageJson), "9.0.0");
    assert.ok(result.diagnostics.some((line) => line.includes(secondary.packageRoot)));
  });
}

test("ENG-731: latest updates the older active npm install instead of rejecting newer pnpm", async () => {
  const active = fixture("npm", "0.16.9");
  const secondary = fixture("pnpm", "0.17.2");
  const path = `${active.bin}:${secondary.bin}`;
  const result = await performSelfUpdate("latest", false, {
    path,
    env: { PATH: path },
    executingEntry: active.entry,
    runner: createCompositeRunner([active, secondary], { metadataVersion: "0.17.4" })
  });
  assert.equal(result.action, "updated");
  assert.equal(result.from, "0.16.9");
  assert.equal(result.to, "0.17.4");
  assert.equal(result.owner.kind, "npm");
  assert.equal(readPackageVersion(secondary.packageJson), "0.17.2");
});

test("PATH collision with a different RouteKit install fails closed", async () => {
  const owned = fixture("npm");
  const collision = fixture("npm", "9.0.0");
  const runner: CommandRunner = async (executable, args, env) => {
    const home = executable.startsWith(collision.bin) ? collision : owned;
    return createRunner(home)(executable, args, env);
  };
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      path: `${collision.bin}:${owned.path}`,
      env: { PATH: `${collision.bin}:${owned.path}` },
      executingEntry: owned.entry,
      runner
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.match(error.message, /first RouteKit executable on PATH/);
      assert.ok(error.remediation?.includes(join(owned.bin, "npm")));
      assert.ok(error.remediation?.includes("--force"));
      assert.ok(error.diagnostics.some((line) => line.includes(collision.packageRoot)));
      assert.ok(error.diagnostics.some((line) => line.includes(owned.packageRoot)));
      assert.ok(error.diagnostics.some((line) => line.includes(join(collision.bin, "routekit"))));
      return true;
    }
  );
});

test("an uninspectable first RouteKit executable fails closed", async () => {
  const owned = fixture("npm");
  const collisionBin = join(mkdtempSync(join(tmpdir(), "routekit-uninspectable-")), "bin");
  mkdirSync(collisionBin, { recursive: true });
  touchExecutable(join(collisionBin, "routekit"));
  const path = `${collisionBin}:${owned.bin}`;
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      path,
      env: { PATH: path },
      executingEntry: owned.entry,
      runner: createRunner(owned)
    }),
    /first RouteKit executable on PATH could not be inspected/
  );
});

test("npm exit zero with a stale tree cannot report updated", async () => {
  const value = fixture("npm");
  await assert.rejects(
    performSelfUpdate("2.0.0", false, options(value, { staleInstall: true })),
    /update verification failed/
  );
});

test("self-inspect and manifest mismatch fails before mutation", async () => {
  const value = fixture("npm");
  const runner: CommandRunner = async (executable, args, env, runOptions) => {
    if (basename(executable) === "routekit" && args[0] === "__self-inspect") {
      return {
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          packageName: "@velum-labs/routekit",
          packageRoot: value.packageRoot,
          entry: value.entry,
          version: "0.9.0"
        })}\n`,
        stderr: "",
        exitCode: 0
      };
    }
    return await createRunner(value)(executable, args, env, runOptions);
  };
  await assert.rejects(
    performSelfUpdate("2.0.0", false, {
      ...options(value),
      runner
    }),
    /does not match a RouteKit executable/
  );
});

test("dry run reports owner and command without mutation", async () => {
  const value = fixture("pnpm");
  const before = readFileSync(value.packageJson, "utf8");
  const result = await performSelfUpdate("2.5.0", true, options(value));
  assert.equal(result.action, "planned");
  assert.equal(result.from, "1.0.0");
  assert.equal(result.to, "1.0.0");
  assert.equal(result.owner.kind, "pnpm");
  assert.equal(readFileSync(value.packageJson, "utf8"), before);
});

for (const dryRun of [true, false]) {
  test(`already-latest self-update is skipped${dryRun ? " in a dry run" : ""}`, async () => {
    const value = fixture("npm", "2.0.0");
    let installCalls = 0;
    const runner = createRunner(value);
    const result = await performSelfUpdate("latest", dryRun, {
      ...options(value),
      runner: async (executable, args, env, runOptions) => {
        if (args[0] === "install") installCalls += 1;
        return await runner(executable, args, env, runOptions);
      }
    });
    assert.equal(result.action, "skipped");
    assert.equal(result.version, "latest");
    assert.equal(result.targetVersion, "2.0.0");
    assert.equal(result.from, "2.0.0");
    assert.equal(result.to, "2.0.0");
    assert.equal(installCalls, 0);
  });
}

test("outdated latest dry run plans an exact install without mutation", async () => {
  const value = fixture("pnpm", "1.0.0");
  const result = await performSelfUpdate("latest", true, {
    ...options(value, { metadataVersion: "2.5.0" })
  });
  assert.equal(result.action, "planned");
  assert.equal(result.targetVersion, "2.5.0");
  assert.deepEqual(result.command.slice(1), [
    "add",
    "-g",
    "@velum-labs/routekit@2.5.0",
    "--config.minimum-release-age=0"
  ]);
  assert.equal(readPackageVersion(value.packageJson), "1.0.0");
});

test("latest resolution failure occurs after ownership inspection and before mutation", async () => {
  const value = fixture("npm");
  let runnerCalls = 0;
  const baseRunner = createRunner(value, { metadataError: "registry unavailable" });
  await assert.rejects(
    performSelfUpdate("latest", false, {
      ...options(value),
      runner: async (executable, args, env, runOptions) => {
        runnerCalls += 1;
        return await baseRunner(executable, args, env, runOptions);
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.equal(error.code, "self_update_metadata_failed");
      assert.ok(error.diagnostics.some((line) => line.includes("registry unavailable")));
      return true;
    }
  );
  assert.ok(runnerCalls > 0);
  assert.equal(readPackageVersion(value.packageJson), "1.0.0");
});

test("diagnostics never include unrelated environment credentials", async () => {
  const value = fixture("npm");
  const secret = "super-secret-registry-token";
  const inspection = await inspectSelfUpdateInstallation("2.0.0", {
    ...options(value),
    env: { PATH: value.path, NPM_TOKEN: secret, ROUTEKIT_TOKEN: secret }
  });
  const serialized = JSON.stringify(inspection.diagnostics);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /PATH RouteKit candidates/);
});

test("PATH collision remediation argv is exact and unchanged", async () => {
  const owned = fixture("npm");
  const collision = fixture("npm", "9.0.0");
  const runner: CommandRunner = async (executable, args, env) => {
    const home = executable.startsWith(collision.bin) ? collision : owned;
    return createRunner(home)(executable, args, env);
  };
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      path: `${collision.bin}:${owned.path}`,
      env: { PATH: `${collision.bin}:${owned.path}` },
      executingEntry: owned.entry,
      runner
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.deepEqual(error.remediation, [
        join(owned.bin, "npm"),
        "install",
        "-g",
        "--force",
        "--no-audit",
        "--no-fund",
        "--prefix",
        owned.prefix,
        "@velum-labs/routekit@2.0.0"
      ]);
      return true;
    }
  );
});

test("remediation is an argv matching the install command", () => {
  assert.deepEqual(
    remediationCommand(
      {
        kind: "npm",
        executable: "/opt/tools/npm",
        packageRoot: "/opt/pkg",
        prefix: "/opt/prefix"
      },
      "1.2.3"
    ),
    [
      "/opt/tools/npm",
      "install",
      "-g",
      "--force",
      "--no-audit",
      "--no-fund",
      "--prefix",
      "/opt/prefix",
      "@velum-labs/routekit@1.2.3"
    ]
  );
  assert.deepEqual(
    remediationCommand(
      {
        kind: "pnpm",
        executable: "/opt/tools/pnpm",
        packageRoot: "/opt/pkg",
        globalBin: "/opt/bin"
      },
      "latest"
    ),
    [
      "/opt/tools/pnpm",
      "add",
      "-g",
      "@velum-labs/routekit@latest",
      "--config.minimum-release-age=0"
    ]
  );
});

test("Yarn Classic global owner updates through yarn global add", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-yarn-"));
  const globalRoot = join(home, "global");
  const bin = join(home, "bin");
  const packageRoot = join(globalRoot, "node_modules", "@velum-labs", "routekit");
  const packageJson = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(packageJson, JSON.stringify({ name: "@velum-labs/routekit", version: "1.0.0" }));
  writeFileSync(entry, "");
  symlinkSync(entry, join(bin, "routekit"));
  const yarn = join(bin, "yarn");
  touchExecutable(yarn);
  const runner: CommandRunner = async (executable, args) => {
    const name = basename(executable);
    if (name === "routekit" && args[0] === "version")
      return { stdout: `@velum-labs/routekit ${readPackageVersion(packageJson)}\n`, stderr: "", exitCode: 0 };
    if (name === "yarn" && args[0] === "--version")
      return { stdout: "1.22.22\n", stderr: "", exitCode: 0 };
    if (name === "yarn" && args[0] === "global" && args[1] === "dir")
      return { stdout: `${globalRoot}\n`, stderr: "", exitCode: 0 };
    if (name === "yarn" && args[0] === "global" && args[1] === "bin")
      return { stdout: `${bin}\n`, stderr: "", exitCode: 0 };
    if (name === "yarn" && args[0] === "global" && args[1] === "add") {
      writePackageVersion(packageJson, "2.0.0");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  const result = await performSelfUpdate("2.0.0", false, {
    path: bin,
    env: { PATH: bin, HOME: home },
    executingEntry: entry,
    runner
  });
  assert.equal(result.owner.kind, "yarn");
  assert.equal(result.to, "2.0.0");
  assert.deepEqual(result.command.slice(1), [
    "global",
    "add",
    "@velum-labs/routekit@2.0.0",
    "--force",
    "--non-interactive"
  ]);
});

test("Bun global owner updates through bun add -g", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-bun-"));
  const bunHome = join(home, ".bun");
  const globalRoot = join(bunHome, "install", "global");
  const bin = join(bunHome, "bin");
  const packageRoot = join(globalRoot, "node_modules", "@velum-labs", "routekit");
  const packageJson = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(globalRoot, "package.json"),
    JSON.stringify({ dependencies: { "@velum-labs/routekit": "1.0.0" } })
  );
  writeFileSync(packageJson, JSON.stringify({ name: "@velum-labs/routekit", version: "1.0.0" }));
  writeFileSync(entry, "");
  symlinkSync(entry, join(bin, "routekit"));
  const bun = join(bin, "bun");
  touchExecutable(bun);
  const runner: CommandRunner = async (executable, args) => {
    const name = basename(executable);
    if (name === "routekit" && args[0] === "version")
      return { stdout: `@velum-labs/routekit ${readPackageVersion(packageJson)}\n`, stderr: "", exitCode: 0 };
    if (name === "bun" && args[0] === "pm" && args[1] === "bin")
      return { stdout: `${bin}\n`, stderr: "", exitCode: 0 };
    if (name === "bun" && args[0] === "add") {
      writePackageVersion(packageJson, "2.0.0");
      writeFileSync(
        join(globalRoot, "package.json"),
        JSON.stringify({ dependencies: { "@velum-labs/routekit": "2.0.0" } })
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  const result = await performSelfUpdate("2.0.0", false, {
    path: bin,
    env: { PATH: bin, HOME: home, BUN_INSTALL: bunHome },
    executingEntry: entry,
    runner
  });
  assert.equal(result.owner.kind, "bun");
  assert.equal(result.to, "2.0.0");
  assert.deepEqual(result.command.slice(1), [
    "add",
    "-g",
    "--exact",
    "--force",
    "@velum-labs/routekit@2.0.0"
  ]);
});

test("Volta owner updates through volta install and verifies the shim", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-volta-"));
  const voltaHome = join(home, ".volta");
  const bin = join(voltaHome, "bin");
  const packageRoot = join(
    voltaHome,
    "tools",
    "image",
    "packages",
    "@velum-labs",
    "routekit",
    "lib",
    "node_modules",
    "@velum-labs",
    "routekit"
  );
  const packageJson = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  const launcher = join(
    voltaHome,
    "tools",
    "image",
    "packages",
    "@velum-labs",
    "routekit",
    "bin",
    "routekit"
  );
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(voltaHome, "tools", "user", "packages", "@velum-labs"), {
    recursive: true
  });
  mkdirSync(join(voltaHome, "tools", "user", "bins"), { recursive: true });
  writeFileSync(
    join(voltaHome, "tools", "user", "packages", "@velum-labs", "routekit.json"),
    JSON.stringify({
      name: "@velum-labs/routekit",
      version: "1.0.0",
      bins: ["routekit"]
    })
  );
  writeFileSync(
    join(voltaHome, "tools", "user", "bins", "routekit.json"),
    JSON.stringify({
      name: "routekit",
      package: "@velum-labs/routekit",
      version: "1.0.0"
    })
  );
  writeFileSync(packageJson, JSON.stringify({ name: "@velum-labs/routekit", version: "1.0.0" }));
  writeFileSync(entry, "");
  touchExecutable(launcher);
  symlinkSync(entry, join(bin, "routekit"));
  const volta = join(bin, "volta");
  touchExecutable(volta);
  const runner: CommandRunner = async (executable, args) => {
    const name = basename(executable);
    if (executable === join(bin, "routekit") && args[0] === "__self-inspect")
      return {
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          packageName: "@velum-labs/routekit",
          packageRoot,
          entry,
          version: readPackageVersion(packageJson),
          processExecPath: process.execPath
        })}\n`,
        stderr: "",
        exitCode: 0
      };
    if (executable === launcher && args[0] === "__self-inspect")
      return {
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          packageName: "@velum-labs/routekit",
          packageRoot,
          entry,
          version: readPackageVersion(packageJson),
          processExecPath: process.execPath
        })}\n`,
        stderr: "",
        exitCode: 0
      };
    if (name === "routekit" && args[0] === "version")
      return { stdout: `@velum-labs/routekit ${readPackageVersion(packageJson)}\n`, stderr: "", exitCode: 0 };
    if (name === "volta" && args[0] === "which")
      return { stdout: `${launcher}\n`, stderr: "", exitCode: 0 };
    if (name === "volta" && args[0] === "install") {
      writePackageVersion(packageJson, "2.0.0");
      writeFileSync(
        join(voltaHome, "tools", "user", "packages", "@velum-labs", "routekit.json"),
        JSON.stringify({
          name: "@velum-labs/routekit",
          version: "2.0.0",
          bins: ["routekit"]
        })
      );
      writeFileSync(
        join(voltaHome, "tools", "user", "bins", "routekit.json"),
        JSON.stringify({
          name: "routekit",
          package: "@velum-labs/routekit",
          version: "2.0.0"
        })
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  const result = await performSelfUpdate("2.0.0", false, {
    path: bin,
    env: { PATH: bin, HOME: home, VOLTA_HOME: voltaHome },
    executingEntry: entry,
    runner
  });
  assert.equal(result.owner.kind, "volta");
  assert.equal(result.to, "2.0.0");
  assert.deepEqual(result.command.slice(1), [
    "install",
    "@velum-labs/routekit@2.0.0"
  ]);
});

test("private installer discovers npm outside PATH and writes a receipt", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-private-"));
  const prefix = join(home, ".local");
  const bin = join(prefix, "bin");
  const packageRoot = join(prefix, "lib", "node_modules", "@velum-labs", "routekit");
  const packageJson = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  const runtimeBin = join(
    prefix,
    "share",
    "routekit",
    "node",
    "node-v22.22.2-darwin-arm64",
    "bin"
  );
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(runtimeBin, { recursive: true });
  writeFileSync(packageJson, JSON.stringify({ name: "@velum-labs/routekit", version: "1.0.0" }));
  writeFileSync(entry, "");
  symlinkSync(entry, join(bin, "routekit"));
  const npm = join(runtimeBin, "npm");
  touchExecutable(npm);
  const runner: CommandRunner = async (executable, args) => {
    const name = basename(executable);
    if (name === "routekit" && args[0] === "version")
      return { stdout: `@velum-labs/routekit ${readPackageVersion(packageJson)}\n`, stderr: "", exitCode: 0 };
    if (name === "npm" && args[0] === "prefix")
      return { stdout: `${prefix}\n`, stderr: "", exitCode: 0 };
    if (name === "npm" && args[0] === "root")
      return { stdout: `${join(prefix, "lib", "node_modules")}\n`, stderr: "", exitCode: 0 };
    if (name === "npm" && args[0] === "install") {
      writePackageVersion(packageJson, "2.0.0");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  const result = await performSelfUpdate("2.0.0", false, {
    path: bin,
    env: { PATH: bin, HOME: home },
    executingEntry: entry,
    processExecPath: join(runtimeBin, "node"),
    runner
  });
  assert.equal(result.owner.kind, "npm");
  assert.equal(result.owner.provenance, "routekit-installer");
  assert.ok(existsSync(join(prefix, "lib", "routekit", "install.json")));
});

test("invalid and tampered installer receipts are ignored until native npm proves ownership", async () => {
  for (const receipt of [
    "{not-json",
    JSON.stringify({
      schemaVersion: 1,
      provenance: "routekit-installer",
      manager: "npm",
      packageName: "@velum-labs/not-routekit",
      prefix: "/tampered",
      npmExecutable: "/tampered/npm",
      nodeExecutable: "/tampered/node",
      routekitExecutable: "/tampered/routekit",
      installMode: "private"
    })
  ]) {
    const value = fixture("npm");
    const receiptDirectory = join(value.prefix, "lib", "routekit");
    mkdirSync(receiptDirectory, { recursive: true });
    writeFileSync(join(receiptDirectory, "install.json"), receipt);
    const inspection = await inspectSelfUpdateInstallation("2.0.0", options(value));
    assert.equal(inspection.owner.kind, "npm");
    assert.equal(inspection.owner.provenance, "package-manager");
    rmSync(value.home, { recursive: true, force: true });
  }
});

test("unowned local installation never falls back to npm remediation", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-local-"));
  const project = join(home, "project");
  const packageRoot = join(project, "node_modules", "@velum-labs", "routekit");
  const packageJson = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  const bin = join(project, "node_modules", ".bin");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ packageManager: "npm@11.0.0" }));
  writeFileSync(packageJson, JSON.stringify({ name: "@velum-labs/routekit", version: "1.0.0" }));
  writeFileSync(entry, "");
  symlinkSync(entry, join(bin, "routekit"));
  const runner: CommandRunner = async (executable, args) => {
    if (basename(executable) === "routekit" && args[0] === "version")
      return { stdout: "@velum-labs/routekit 1.0.0\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      path: bin,
      env: { PATH: bin },
      executingEntry: entry,
      runner
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.equal(error.code, "self_update_local_install");
      assert.equal(error.remediation, undefined);
      return true;
    }
  );
});

test("Yarn Berry local execution is refused without a global mutation command", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-yarn-berry-"));
  const project = join(home, "project");
  const packageRoot = join(project, "node_modules", "@velum-labs", "routekit");
  const entry = join(packageRoot, "dist", "index.js");
  const bin = join(project, "node_modules", ".bin");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ packageManager: "yarn@4.6.0" }));
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@velum-labs/routekit", version: "1.0.0" })
  );
  writeFileSync(entry, "");
  symlinkSync(entry, join(bin, "routekit"));
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      path: bin,
      env: { PATH: bin, HOME: home },
      executingEntry: entry,
      runner: async (executable, args) =>
        basename(executable) === "routekit" && args[0] === "version"
          ? { stdout: "@velum-labs/routekit 1.0.0\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 }
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.equal(error.code, "self_update_yarn_berry");
      assert.equal(error.remediation, undefined);
      return true;
    }
  );
});

test("Homebrew ownership is guided without being overwritten", async () => {
  const value = fixture("npm");
  const tools = mkdtempSync(join(tmpdir(), "routekit-self-update-brew-"));
  const brew = join(tools, "brew");
  touchExecutable(brew);
  const path = `${value.path}:${tools}`;
  const runner: CommandRunner = async (executable, args, env, runOptions) => {
    if (basename(executable) === "npm") return { stdout: "", stderr: "", exitCode: 1 };
    if (basename(executable) === "brew" && args[0] === "which-formula")
      return { stdout: "velum-labs/tap/routekit\n", stderr: "", exitCode: 0 };
    return await createRunner(value)(executable, args, env, runOptions);
  };
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      path,
      env: { PATH: path },
      executingEntry: value.entry,
      runner
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.equal(error.code, "self_update_external_owner");
      assert.deepEqual(error.remediation, [
        brew,
        "upgrade",
        "velum-labs/tap/routekit"
      ]);
      return true;
    }
  );
});

test("Linux system package managers are detected and only return external guidance", async () => {
  const cases = [
    {
      manager: "dpkg-query",
      args: ["-S"],
      stdout: "routekit: /usr/bin/routekit\n",
      remediationTail: ["install", "--only-upgrade", "routekit"]
    },
    {
      manager: "rpm",
      args: ["-qf"],
      stdout: "routekit-2.0.0-1.x86_64\n",
      remediationTail: ["upgrade", "routekit-2.0.0-1.x86_64"]
    },
    {
      manager: "pacman",
      args: ["-Qo"],
      stdout: "/usr/bin/routekit is owned by routekit 2.0.0-1\n",
      remediationTail: ["-S", "routekit"]
    }
  ] as const;
  for (const candidate of cases) {
    const value = fixture("npm");
    const tools = mkdtempSync(join(tmpdir(), `routekit-self-update-${candidate.manager}-`));
    const manager = join(tools, candidate.manager);
    touchExecutable(manager);
    if (candidate.manager === "dpkg-query") touchExecutable(join(tools, "apt-get"));
    if (candidate.manager === "rpm") touchExecutable(join(tools, "dnf"));
    const path = `${value.path}:${tools}`;
    await assert.rejects(
      inspectSelfUpdateInstallation("2.0.0", {
        path,
        platform: "linux",
        env: { PATH: path },
        executingEntry: value.entry,
        runner: async (executable, args, env, runOptions) => {
          if (basename(executable) === "npm")
            return { stdout: "", stderr: "", exitCode: 1 };
          if (
            basename(executable) === candidate.manager &&
            args.slice(0, candidate.args.length).join(" ") === candidate.args.join(" ")
          )
            return { stdout: candidate.stdout, stderr: "", exitCode: 0 };
          return await createRunner(value)(executable, args, env, runOptions);
        }
      }),
      (error: unknown) => {
        assert.ok(error instanceof SelfUpdateInspectionError);
        assert.equal(error.code, "self_update_external_owner");
        assert.equal(error.remediation?.[0], "sudo");
        assert.deepEqual(error.remediation?.slice(2), candidate.remediationTail);
        return true;
      }
    );
    rmSync(value.home, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});

test("Snap and Nix ownership are detected without invoking a JavaScript manager", async () => {
  const cases = [
    {
      name: "snap",
      routekitPath: "/snap/bin/routekit",
      manager: "snap",
      managerArgs: ["list", "routekit"],
      stdout: "Name Version Rev Tracking Publisher Notes\nroutekit 2.0.0 1 latest stable -\n",
      remediationTail: ["refresh", "routekit"]
    },
    {
      name: "nix",
      routekitPath: "/nix/store/fixture-routekit/bin/routekit",
      manager: "nix-store",
      managerArgs: ["--query", "--deriver"],
      stdout: "/nix/store/fixture-routekit.drv\n",
      remediationTail: undefined
    }
  ] as const;
  for (const candidate of cases) {
    const value = fixture("npm");
    const tools = mkdtempSync(join(tmpdir(), `routekit-self-update-${candidate.name}-`));
    const manager = join(tools, candidate.manager);
    touchExecutable(manager);
    const path = `${value.path}:${tools}`;
    const external = await detectExternalOwner(candidate.routekitPath, {
      packageRoot: value.packageRoot,
      pathValue: path,
      platform: "linux",
      env: { PATH: path },
      processExecPath: process.execPath,
      neutralCwd: value.home,
      diagnostics: [],
      runner: async (executable, args) =>
        basename(executable) === candidate.manager &&
        args.slice(0, candidate.managerArgs.length).join(" ") === candidate.managerArgs.join(" ")
          ? { stdout: candidate.stdout, stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 }
    });
    assert.equal(external?.kind, candidate.name);
    if (candidate.remediationTail === undefined) {
      assert.equal(external?.remediation, undefined);
    } else {
      assert.equal(external?.remediation?.[0], "sudo");
      assert.deepEqual(external?.remediation?.slice(2), candidate.remediationTail);
    }
    rmSync(value.home, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});

test("npm-linked development execution is refused as a local installation", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-npm-link-"));
  const project = join(home, "routekit-checkout");
  const packageRoot = join(project, "packages", "cli");
  const entry = join(packageRoot, "dist", "index.js");
  const bin = join(home, ".npm-global", "bin");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ private: true, packageManager: "pnpm@11.15.1" })
  );
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@velum-labs/routekit", version: "1.0.0" })
  );
  writeFileSync(entry, "");
  symlinkSync(entry, join(bin, "routekit"));
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      path: bin,
      env: { PATH: bin, HOME: home },
      executingEntry: entry,
      runner: async (executable, args) =>
        basename(executable) === "routekit" && args[0] === "version"
          ? { stdout: "@velum-labs/routekit 1.0.0\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 }
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.equal(error.code, "self_update_local_install");
      assert.equal(error.remediation, undefined);
      return true;
    }
  );
});

test("self-update lock rejects a live owner and recovers a stale owner", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-self-update-lock-"));
  const first = acquireSelfUpdateLock("npm:/prefix", root);
  assert.throws(() => acquireSelfUpdateLock("npm:/prefix", root), /already running/);
  first.release();
  const stale = acquireSelfUpdateLock("npm:/prefix", root);
  const metadataPath = join(stale.path, "owner.json");
  stale.release();
  mkdirSync(stale.path, { recursive: true });
  writeFileSync(
    metadataPath,
    JSON.stringify({ pid: 999_999_999, contextId: "npm:/prefix", acquiredAt: "old" })
  );
  const recovered = acquireSelfUpdateLock("npm:/prefix", root);
  recovered.release();
  rmSync(root, { recursive: true, force: true });
});

test("candidate probes and installs use distinct default timeouts", async () => {
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    '  probe) sleep 0.05; printf "probe\\n" ;;',
    '  install) sleep 0.05; printf "install\\n" ;;',
    "esac",
    ""
  ].join("\n");
  const directory = mkdtempSync(join(tmpdir(), "routekit-self-update-timeout-"));
  const executable = join(directory, "manager");
  writeFileSync(executable, script, { mode: 0o755 });
  const probe = await defaultRunner(executable, ["probe"], process.env, {
    operation: "probe",
    timeoutMs: 5
  });
  assert.equal(probe.timedOut, true);
  const install = await defaultRunner(executable, ["install"], process.env, {
    operation: "install",
    timeoutMs: 5_000
  });
  assert.equal(install.exitCode, 0);
  assert.equal(install.stdout.trim(), "install");
});

test("diagnostic tails redact registry credentials and sensitive environment values", async () => {
  const value = fixture("npm");
  const secret = "registry-secret-value";
  const runner = createRunner(value);
  await assert.rejects(
    performSelfUpdate("2.0.0", false, {
      ...options(value),
      env: { PATH: value.path, NPM_TOKEN: secret },
      runner: async (executable, args, env, runOptions) => {
        if (basename(executable) === "npm" && args[0] === "install") {
          return {
            stdout: "",
            stderr: [
              `npm ERR! Bearer ${secret}`,
              `npm ERR! //registry.example.test/:_authToken=${secret}`,
              `npm ERR! https://user:${secret}@registry.example.test/package`
            ].join("\n"),
            exitCode: 1
          };
        }
        return await runner(executable, args, env, runOptions);
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      const serialized = JSON.stringify(error.diagnostics);
      assert.doesNotMatch(serialized, new RegExp(secret));
      assert.match(serialized, /redacted/);
      return true;
    }
  );
});

test("ephemeral execution is refused without a mutation command", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-self-update-npx-"));
  const packageRoot = join(
    home,
    ".npm",
    "_npx",
    "fixture",
    "node_modules",
    "@velum-labs",
    "routekit"
  );
  const entry = join(packageRoot, "dist", "index.js");
  const bin = join(home, ".npm", "_npx", "fixture", "node_modules", ".bin");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@velum-labs/routekit", version: "1.0.0" })
  );
  writeFileSync(entry, "");
  symlinkSync(entry, join(bin, "routekit"));
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      path: bin,
      env: { PATH: bin, HOME: home },
      executingEntry: entry,
      runner: async (executable, args) =>
        basename(executable) === "routekit" && args[0] === "version"
          ? { stdout: "@velum-labs/routekit 1.0.0\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 }
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.equal(error.code, "self_update_ephemeral_install");
      assert.equal(error.remediation, undefined);
      return true;
    }
  );
});

test("unsupported platforms fail before probing or mutating", async () => {
  let calls = 0;
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      platform: "win32",
      runner: async () => {
        calls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof SelfUpdateInspectionError);
      assert.equal(error.code, "self_update_platform_unsupported");
      return true;
    }
  );
  assert.equal(calls, 0);
});
