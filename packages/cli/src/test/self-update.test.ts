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
import { dirname, join } from "node:path";
import test from "node:test";

import {
  inspectSelfUpdateInstallation,
  performSelfUpdate,
  remediationCommand,
  SelfUpdateInspectionError
} from "../self-update-inspector.js";

type Fixture = {
  home: string;
  bin: string;
  packageRoot: string;
  entry: string;
  path: string;
};

function executable(path: string, source: string): void {
  writeFileSync(path, `#!${process.execPath}\n${source}\n`);
  chmodSync(path, 0o755);
}

function fixture(kind: "npm" | "pnpm", version = "1.0.0", suffix = ""): Fixture {
  const home = mkdtempSync(join(tmpdir(), `routekit-self-update-${kind}-`));
  const prefix = join(home, suffix || "global");
  const bin = kind === "npm" ? join(prefix, "bin") : join(home, "pnpm-bin");
  const root =
    kind === "npm"
      ? join(prefix, "lib", "node_modules")
      : join(home, suffix || "pnpm-global", "5", "node_modules");
  const packageRoot = join(root, "@velum-labs", "routekit");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@velum-labs/routekit", version })
  );
  executable(
    entry,
    `const p=${JSON.stringify(join(packageRoot, "package.json"))}; const v=JSON.parse(require("node:fs").readFileSync(p,"utf8")).version; process.stdout.write("@velum-labs/routekit "+v+"\\n")`
  );
  symlinkSync(entry, join(bin, "routekit"));
  const path = bin;
  if (kind === "npm") {
    executable(
      join(bin, "npm"),
      `
const fs=require("node:fs"); const args=process.argv.slice(2);
if(args[0]==="prefix"&&args[1]==="-g") process.stdout.write(${JSON.stringify(prefix)}+"\\n");
else if(args[0]==="root"&&args[1]==="-g") process.stdout.write(${JSON.stringify(root)}+"\\n");
else if(args[0]==="install") { const requested=args.at(-1).split("@").at(-1); const p=${JSON.stringify(join(packageRoot, "package.json"))}; const m=JSON.parse(fs.readFileSync(p)); m.version=requested==="latest"?"2.0.0":requested; fs.writeFileSync(p,JSON.stringify(m)); }
else process.exitCode=2;`
    );
  } else {
    executable(
      join(bin, "pnpm"),
      `
const fs=require("node:fs"); const args=process.argv.slice(2);
if(args[0]==="bin"&&args[1]==="-g") process.stdout.write(${JSON.stringify(bin)}+"\\n");
else if(args[0]==="root"&&args[1]==="-g") process.stdout.write(${JSON.stringify(root)}+"\\n");
else if(args[0]==="add") { const requested=args.at(-1).split("@").at(-1); const p=${JSON.stringify(join(packageRoot, "package.json"))}; const m=JSON.parse(fs.readFileSync(p)); m.version=requested==="latest"?"2.1.0":requested; fs.writeFileSync(p,JSON.stringify(m)); }
else process.exitCode=2;`
    );
  }
  return { home, bin, packageRoot, entry, path };
}

function options(value: Fixture) {
  return { path: value.path, env: { PATH: value.path }, executingEntry: value.entry };
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
  await assert.rejects(
    inspectSelfUpdateInstallation("2.0.0", {
      ...options(owned),
      path: `${collision.bin}:${owned.path}`,
      env: { PATH: `${collision.bin}:${owned.path}` }
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
  executable(
    join(value.bin, "npm"),
    `if(process.argv[2]==="prefix") process.stdout.write(${JSON.stringify(join(value.home, "global"))}+"\\n"); else if(process.argv[2]==="root") process.stdout.write(${JSON.stringify(join(value.home, "global", "lib", "node_modules"))}+"\\n")`
  );
  await assert.rejects(
    performSelfUpdate("2.0.0", false, options(value)),
    /update verification failed/
  );
});

test("manifest and executable mismatch fails before mutation", async () => {
  const value = fixture("npm");
  executable(value.entry, 'process.stdout.write("@velum-labs/routekit 0.9.0\\n")');
  await assert.rejects(
    performSelfUpdate("2.0.0", false, options(value)),
    /manifest and executable versions do not match/
  );
});

test("dry run reports owner and command without mutation", async () => {
  const value = fixture("pnpm");
  const before = readFileSync(join(value.packageRoot, "package.json"), "utf8");
  const result = await performSelfUpdate("2.5.0", true, options(value));
  assert.equal(result.action, "planned");
  assert.equal(result.from, "1.0.0");
  assert.equal(result.to, "1.0.0");
  assert.equal(result.owner.kind, "pnpm");
  assert.equal(readFileSync(join(value.packageRoot, "package.json"), "utf8"), before);
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
