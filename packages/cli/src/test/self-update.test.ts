import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  type CommandResult,
  type CommandRunner,
  inspectSelfUpdateInstallation,
  performSelfUpdate,
  remediationCommand,
  SelfUpdateInspectionError
} from "../self-update-inspector.js";

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
};

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

    if (name === "npm") {
      if (args[0] === "prefix" && args[1] === "-g") return ok(`${value.prefix}\n`);
      if (args[0] === "root" && args[1] === "-g") return ok(`${value.root}\n`);
      if (args[0] === "install") {
        if (behavior.staleInstall === true) return ok("");
        const requested = args.at(-1)?.split("@").at(-1) ?? "";
        writePackageVersion(value.packageJson, requested);
        return ok("");
      }
      return fail();
    }

    if (name === "pnpm") {
      if (args[0] === "bin" && args[1] === "-g") return ok(`${value.bin}\n`);
      if (args[0] === "root" && args[1] === "-g") return ok(`${value.root}\n`);
      if (args[0] === "list" && args[1] === "-g") {
        const path = value.listedPackageRoot;
        return path === undefined
          ? fail()
          : ok(
              JSON.stringify([
                {
                  path: value.root,
                  dependencies: {
                    "@velum-labs/routekit": {
                      version: readPackageVersion(value.packageJson),
                      path
                    }
                  }
                }
              ])
            );
      }
      if (args[0] === "add") {
        if (
          behavior.expectedPnpmHome !== undefined &&
          env.PNPM_HOME !== behavior.expectedPnpmHome
        )
          return fail();
        if (behavior.staleInstall === true) return ok("");
        const requested = args.at(-1)?.split("@").at(-1) ?? "";
        if (value.listedPackageRoot === undefined) writePackageVersion(value.packageJson, requested);
        else relocatePnpmV11Package(value, requested);
        return ok("");
      }
      return fail();
    }

    return fail(127);
  };
}

function createCompositeRunner(values: readonly Fixture[]): CommandRunner {
  return async (executable, args, env) => {
    const value = values.find((candidate) => executable.startsWith(candidate.bin));
    if (value === undefined) return { stdout: "", stderr: "", exitCode: 127 };
    return await createRunner(value)(executable, args, env);
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
  assert.deepEqual(result.command.slice(1, 6), [
    "install",
    "-g",
    "--force",
    "--prefix",
    join(value.home, "global")
  ]);
});

test("pnpm global owner supports versioned global roots", async () => {
  for (const suffix of ["pnpm-v3", "pnpm-v10"]) {
    const value = fixture("pnpm", "1.0.0", suffix);
    const result = await performSelfUpdate("latest", false, {
      ...options(value),
      resolveVersion: async () => "2.1.0"
    });
    assert.equal(result.owner.kind, "pnpm");
    assert.equal(result.owner.globalRoot, join(value.home, suffix, "5", "node_modules"));
    assert.equal(result.to, "2.1.0");
    assert.equal(result.version, "latest");
    assert.equal(result.targetVersion, "2.1.0");
    assert.deepEqual(result.command.slice(1), ["add", "-g", "@velum-labs/routekit@2.1.0"]);
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
    "@velum-labs/routekit@2.0.0"
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
    runner: createCompositeRunner([active, secondary]),
    resolveVersion: async () => "0.17.4"
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
      assert.ok(error.remediation.includes(join(owned.bin, "npm")));
      assert.ok(error.remediation.includes("--force"));
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

test("manifest and executable mismatch fails before mutation", async () => {
  const value = fixture("npm");
  await assert.rejects(
    performSelfUpdate("2.0.0", false, options(value, { reportedVersion: "0.9.0" })),
    /manifest and executable versions do not match/
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
      runner: async (executable, args, env) => {
        if (args[0] === "install") installCalls += 1;
        return await runner(executable, args, env);
      },
      resolveVersion: async () => "2.0.0"
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
    ...options(value),
    resolveVersion: async () => "2.5.0"
  });
  assert.equal(result.action, "planned");
  assert.equal(result.targetVersion, "2.5.0");
  assert.deepEqual(result.command.slice(1), ["add", "-g", "@velum-labs/routekit@2.5.0"]);
  assert.equal(readPackageVersion(value.packageJson), "1.0.0");
});

test("latest resolution failure occurs before installation inspection or mutation", async () => {
  const value = fixture("npm");
  let runnerCalls = 0;
  await assert.rejects(
    performSelfUpdate("latest", false, {
      ...options(value),
      runner: async () => {
        runnerCalls += 1;
        return { stdout: "", stderr: "", exitCode: 1 };
      },
      resolveVersion: async () => {
        throw new Error("registry unavailable");
      }
    }),
    /registry unavailable/
  );
  assert.equal(runnerCalls, 0);
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
    ["/opt/tools/pnpm", "add", "-g", "@velum-labs/routekit@latest"]
  );
});
