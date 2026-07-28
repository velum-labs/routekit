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
};

type RunnerBehavior = {
  /** When set, `routekit version` reports this instead of the package.json version. */
  reportedVersion?: string;
  /** When true, install/add succeeds but leaves the package tree unchanged. */
  staleInstall?: boolean;
  /** Desired version written by a successful `latest` install. */
  latestVersion?: string;
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

function createRunner(value: Fixture, behavior: RunnerBehavior = {}): CommandRunner {
  const latestVersion =
    behavior.latestVersion ?? (value.manager.endsWith("pnpm") ? "2.1.0" : "2.0.0");

  return async (executable, args): Promise<CommandResult> => {
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
        const requested = args.at(-1)?.split("@").at(-1) ?? "latest";
        writePackageVersion(value.packageJson, requested === "latest" ? latestVersion : requested);
        return ok("");
      }
      return fail();
    }

    if (name === "pnpm") {
      if (args[0] === "bin" && args[1] === "-g") return ok(`${value.bin}\n`);
      if (args[0] === "root" && args[1] === "-g") return ok(`${value.root}\n`);
      if (args[0] === "add") {
        if (behavior.staleInstall === true) return ok("");
        const requested = args.at(-1)?.split("@").at(-1) ?? "latest";
        writePackageVersion(value.packageJson, requested === "latest" ? latestVersion : requested);
        return ok("");
      }
      return fail();
    }

    return fail(127);
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
    const result = await performSelfUpdate("latest", false, options(value));
    assert.equal(result.owner.kind, "pnpm");
    assert.equal(result.owner.globalRoot, join(value.home, suffix, "5", "node_modules"));
    assert.equal(result.to, "2.1.0");
    assert.deepEqual(result.command.slice(1), ["add", "-g", "@velum-labs/routekit@latest"]);
  }
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
      assert.match(error.remediation, new RegExp(join(owned.bin, "npm")));
      assert.match(error.remediation, /install.*--force/);
      assert.ok(error.diagnostics.some((line) => line.includes(collision.packageRoot)));
      assert.ok(error.diagnostics.some((line) => line.includes(owned.packageRoot)));
      assert.ok(error.diagnostics.some((line) => line.includes(join(collision.bin, "routekit"))));
      return true;
    }
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

test("remediation quoting contains hostile characters on both platforms", () => {
  const owner = {
    kind: "npm" as const,
    executable: "/opt/tools/npm",
    packageRoot: "/opt/pkg"
  };
  const quoted = (prefix: string, platform: "win32" | "linux") =>
    remediationCommand({ ...owner, prefix }, "1.2.3", platform);

  // An embedded quote stays inside the argument instead of starting a command.
  assert.ok(quoted('C:\\node";calc.exe', "win32").includes('"C:\\node\\";calc.exe"'));
  // A trailing backslash is doubled so it cannot escape the closing quote.
  assert.ok(quoted("C:\\node\\", "win32").includes('"C:\\node\\\\"'));
  assert.ok(quoted("/tmp/a'b; rm -rf /", "linux").includes("'/tmp/a'\"'\"'b; rm -rf /'"));
});
