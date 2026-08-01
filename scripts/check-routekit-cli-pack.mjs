import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function startMockProvider() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        'const { createServer } = require("node:http");',
        "const server = createServer((request, response) => {",
        '  response.setHeader("content-type", "application/json");',
        '  if (request.url === "/v1/models") {',
        '    response.end(JSON.stringify({ data: [{ id: "pack-model", object: "model" }] }));',
        "  } else {",
        '    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));',
        "  }",
        "});",
        'server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));',
        'process.on("SIGTERM", () => server.close(() => process.exit(0)));'
      ].join("\n")
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const port = await new Promise((resolvePort, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n", 1)[0];
      if (/^\d+$/.test(line)) resolvePort(Number(line));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`mock provider exited before readiness (${code ?? "signal"})`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await exited;
    }
  };
}

const ROUTEKIT_SCOPE = "@velum-labs/routekit";
const FORBIDDEN_PRODUCT = ["fu", "sion", "kit"].join("");
const FORBIDDEN_SCOPE = `@${FORBIDDEN_PRODUCT}/`;
const root = process.cwd();
const rootPackageManager = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8")
).packageManager;
const packageEntries = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = join(root, "packages", entry.name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) return undefined;
    return {
      directory,
      manifest: JSON.parse(readFileSync(manifestPath, "utf8"))
    };
  })
  .filter((entry) => entry !== undefined);
const byName = new Map(packageEntries.map((entry) => [entry.manifest.name, entry]));
const closure = [];
const pending = ["@velum-labs/routekit"];
const seen = new Set();
while (pending.length > 0) {
  const name = pending.shift();
  if (name === undefined || seen.has(name)) continue;
  seen.add(name);
  if (!name.startsWith(ROUTEKIT_SCOPE)) {
    throw new Error(`RouteKit package closure reached non-RouteKit workspace dependency ${name}`);
  }
  const entry = byName.get(name);
  if (entry === undefined) continue;
  closure.push(entry);
  for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
    if (dependency.startsWith(ROUTEKIT_SCOPE)) {
      pending.push(dependency);
    }
  }
}

const temporary = mkdtempSync(join(tmpdir(), "routekit-pack-smoke-"));
const tarballs = join(temporary, "tarballs");
const install = join(temporary, "install");
const pnpmInstall = join(temporary, "pnpm-install");
try {
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(install, { recursive: true });
  mkdirSync(pnpmInstall, { recursive: true });
  const packedByName = new Map();
  for (const entry of closure) {
    const before = new Set(readdirSync(tarballs));
    execFileSync("pnpm", ["pack", "--pack-destination", tarballs], {
      cwd: entry.directory,
      stdio: "pipe"
    });
    const created = readdirSync(tarballs).filter(
      (name) => name.endsWith(".tgz") && !before.has(name)
    );
    if (created.length !== 1) {
      throw new Error(
        `packing ${entry.manifest.name} created ${created.length} tarballs instead of one`
      );
    }
    packedByName.set(entry.manifest.name, resolve(tarballs, created[0]));
  }
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify({ name: "routekit-install-smoke", private: true }, null, 2)}\n`
  );
  const packed = readdirSync(tarballs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => resolve(tarballs, name));
  const pnpmOverrides = Object.fromEntries(
    [...packedByName].map(([name, tarball]) => [name, `file:${tarball}`])
  );
  writeFileSync(
    join(pnpmInstall, "package.json"),
    `${JSON.stringify(
      {
        name: "routekit-pnpm-install-smoke",
        private: true,
        packageManager: rootPackageManager,
        dependencies: {
          "@velum-labs/routekit": pnpmOverrides["@velum-labs/routekit"]
        }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(pnpmInstall, "pnpm-workspace.yaml"),
    [
      "packages:",
      '  - "."',
      "minimumReleaseAge: 0",
      "overrides:",
      ...Object.entries(pnpmOverrides).map(
        ([name, tarball]) => `  ${JSON.stringify(name)}: ${JSON.stringify(tarball)}`
      ),
      ""
    ].join("\n")
  );
  const pnpmResult = spawnSync("pnpm", ["install", "--ignore-scripts", "--reporter=append-only"], {
    cwd: pnpmInstall,
    encoding: "utf8"
  });
  const pnpmOutput = `${pnpmResult.stdout ?? ""}\n${pnpmResult.stderr ?? ""}`;
  if (pnpmResult.status !== 0) {
    throw new Error(`pnpm packed install failed:\n${pnpmOutput.trim()}`);
  }
  const dependencyWarning =
    /deprecated subdependencies|issues with peer dependencies|unmet peer/i.exec(pnpmOutput);
  if (dependencyWarning !== null) {
    throw new Error(
      `pnpm packed install reported dependency warning "${dependencyWarning[0]}":\n${pnpmOutput.trim()}`
    );
  }
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packed], {
    cwd: install,
    stdio: "pipe"
  });
  for (const scope of readdirSync(join(install, "node_modules"), { withFileTypes: true })) {
    if (!scope.isDirectory() || !scope.name.startsWith("@")) continue;
    // Only the forbidden parent-product scope is banned; third-party scopes from
    // the approved catalog (and their transitive deps) are expected.
    if (scope.name === FORBIDDEN_SCOPE.slice(0, -1)) {
      throw new Error(`smoke install unexpectedly contains ${FORBIDDEN_SCOPE} packages`);
    }
  }
  if (existsSync(join(install, "node_modules", FORBIDDEN_SCOPE.slice(0, -1)))) {
    throw new Error(`smoke install unexpectedly contains ${FORBIDDEN_SCOPE} packages`);
  }
  const output = execFileSync(join(install, "node_modules", ".bin", "routekit"), ["version"], {
    cwd: install,
    encoding: "utf8"
  });
  if (!output.includes("@velum-labs/routekit")) {
    throw new Error(`installed routekit executable returned unexpected output: ${output}`);
  }

  // Inlined shell programs ship inside dist/generated; without them remote
  // install and the SSH relay cannot run after a clean npm install.
  const shellScripts = join(
    install,
    "node_modules",
    "@velum-labs",
    "routekit",
    "dist",
    "generated",
    "shell-scripts.js"
  );
  if (!existsSync(shellScripts)) {
    throw new Error("packed CLI is missing dist/generated/shell-scripts.js");
  }
  const shellModule = await import(resolve(shellScripts));
  for (const name of [
    "REMOTE_PATH_PREAMBLE",
    "PROBE_SCRIPT",
    "INSTALL_SCRIPT",
    "RELAY_SCRIPT",
    "PEER_ADD_SCRIPT",
    "SHELL_SCRIPT_DIGESTS"
  ]) {
    if (shellModule[name] === undefined) {
      throw new Error(`packed shell-scripts.js is missing export ${name}`);
    }
  }
  if (
    typeof shellModule.REMOTE_PATH_PREAMBLE !== "string" ||
    !shellModule.REMOTE_PATH_PREAMBLE.startsWith("set -u\n")
  ) {
    throw new Error("packed REMOTE_PATH_PREAMBLE is not a usable shell program");
  }

  const routekit = join(install, "node_modules", ".bin", "routekit");
  const home = join(temporary, "home");
  const stateHome = join(temporary, "state");
  const configDirectory = join(home, ".config", "routekit");
  mkdirSync(configDirectory, { recursive: true });
  const provider = await startMockProvider();
  writeFileSync(
    join(configDirectory, "router.yaml"),
    "providers:\n  openai: {}\ndefaultModel: openai/pack-model\n"
  );
  const daemonEnv = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_NO_SUPERVISOR: "1",
    ROUTEKIT_PORTLESS: "0",
    PORTLESS: "0",
    NO_COLOR: "1",
    OPENAI_API_KEY: "pack-test-key",
    OPENAI_BASE_URL: provider.url
  };
  let daemonStarted = false;
  try {
    const started = JSON.parse(
      execFileSync(routekit, ["start", "--port", "0", "--no-portless", "--json"], {
        cwd: install,
        env: daemonEnv,
        encoding: "utf8"
      })
    );
    daemonStarted = true;
    if (
      started.supervisor !== "detached" ||
      typeof started.pid !== "number" ||
      typeof started.url !== "string"
    ) {
      throw new Error(`packed daemon returned unexpected start status: ${JSON.stringify(started)}`);
    }
    const status = JSON.parse(
      execFileSync(routekit, ["status", "--json"], {
        cwd: install,
        env: daemonEnv,
        encoding: "utf8"
      })
    );
    if (status.daemon?.pid !== started.pid || status.daemon?.dataUrl !== started.url) {
      throw new Error(`packed daemon status did not match start: ${JSON.stringify(status)}`);
    }
    const catalog = JSON.parse(
      execFileSync(routekit, ["models", "list", "--json"], {
        cwd: install,
        env: daemonEnv,
        encoding: "utf8"
      })
    );
    if (!Array.isArray(catalog.models)) {
      throw new Error(
        `packed daemon returned an invalid model catalog: ${JSON.stringify(catalog)}`
      );
    }
  } finally {
    if (daemonStarted) {
      execFileSync(routekit, ["stop", "--force", "--json"], {
        cwd: install,
        env: daemonEnv,
        stdio: "pipe"
      });
    }
    await provider.close();
  }
  // Offline old → new self-update: stamp a global npm install to OLD, update
  // via local tarballs through the inspector, then prove a fresh PATH spawn
  // reports NEW.
  const globalPrefix = join(temporary, "npm-global");
  mkdirSync(join(globalPrefix, "lib"), { recursive: true });
  execFileSync(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      globalPrefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...packed
    ],
    { stdio: "pipe" }
  );
  const globalBin = join(globalPrefix, "bin");
  const globalPackageRoot = join(globalPrefix, "lib", "node_modules", "@velum-labs", "routekit");
  const globalPackageJson = join(globalPackageRoot, "package.json");
  const globalEntry = join(globalPackageRoot, "dist", "index.js");
  const globalRoutekit = join(globalBin, "routekit");
  if (!existsSync(globalRoutekit) || !existsSync(globalEntry)) {
    throw new Error("npm global smoke install did not produce a routekit executable");
  }
  const newVersion = JSON.parse(readFileSync(globalPackageJson, "utf8")).version;
  if (typeof newVersion !== "string" || newVersion.length === 0) {
    throw new Error("packed RouteKit package.json is missing a version");
  }
  const oldVersion = newVersion === "0.15.0" ? "0.14.0" : "0.15.0";
  writeFileSync(
    globalPackageJson,
    `${JSON.stringify(
      { ...JSON.parse(readFileSync(globalPackageJson, "utf8")), version: oldVersion },
      null,
      2
    )}\n`
  );
  const updateTools = join(temporary, "update-tools");
  mkdirSync(updateTools, { recursive: true });
  const systemNpm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
  if (!existsSync(systemNpm)) {
    throw new Error("npm is required for the self-update pack smoke");
  }
  // Keep PATH hermetic: stamped global bin + a tools dir with npm/node only,
  // so developer-machine RouteKit shims cannot collide with the fixture.
  writeFileSync(
    join(updateTools, "npm"),
    ["#!/bin/sh", `exec ${JSON.stringify(systemNpm)} "$@"`, ""].join("\n"),
    { mode: 0o755 }
  );
  writeFileSync(
    join(updateTools, "node"),
    ["#!/bin/sh", `exec ${JSON.stringify(process.execPath)} "$@"`, ""].join("\n"),
    { mode: 0o755 }
  );
  const updatePath = `${globalBin}${delimiter}${updateTools}`;
  const updateEnv = { ...process.env, PATH: updatePath, NO_COLOR: "1" };
  const oldOutput = execFileSync(globalRoutekit, ["version"], {
    encoding: "utf8",
    env: updateEnv
  });
  if (!oldOutput.includes(oldVersion)) {
    throw new Error(
      `expected stamped PATH routekit version ${oldVersion}, got: ${oldOutput.trim()}`
    );
  }
  const inspectorUrl = pathToFileURL(
    join(globalPackageRoot, "dist", "self-update-inspector.js")
  ).href;
  const { performSelfUpdate } = await import(inspectorUrl);
  const globalRoot = join(globalPrefix, "lib", "node_modules");
  const result = await performSelfUpdate(newVersion, false, {
    path: updatePath,
    env: updateEnv,
    executingEntry: globalEntry,
    runner: async (executable, args, env) => {
      try {
        if (basename(executable) === "npm") {
          if (args[0] === "prefix" && args[1] === "-g") {
            return { stdout: `${globalPrefix}\n`, stderr: "", exitCode: 0 };
          }
          if (args[0] === "root" && args[1] === "-g") {
            return { stdout: `${globalRoot}\n`, stderr: "", exitCode: 0 };
          }
          if (args[0] === "install") {
            // Reinstall the whole packed closure: the CLI tarball alone would
            // send npm to the registry for sibling @velum-labs/* versions that
            // are not published yet.
            execFileSync(
              systemNpm,
              [
                "install",
                "-g",
                "--force",
                "--prefix",
                globalPrefix,
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                ...packed
              ],
              { encoding: "utf8", env, stdio: "pipe" }
            );
            return { stdout: "", stderr: "", exitCode: 0 };
          }
        }
        const stdout = execFileSync(executable, [...args], {
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "pipe"]
        });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (error) {
        const candidate = error;
        return {
          stdout: candidate.stdout?.toString?.() ?? "",
          stderr: candidate.stderr?.toString?.() ?? String(candidate.message ?? candidate),
          exitCode: typeof candidate.status === "number" ? candidate.status : 1
        };
      }
    }
  });
  if (result.action !== "updated" || result.from !== oldVersion || result.to !== newVersion) {
    throw new Error(`self-update inspector returned unexpected payload: ${JSON.stringify(result)}`);
  }
  const freshOutput = execFileSync(globalRoutekit, ["version"], {
    encoding: "utf8",
    env: updateEnv
  });
  if (!freshOutput.includes(newVersion)) {
    throw new Error(
      `expected fresh PATH routekit version ${newVersion}, got: ${freshOutput.trim()}`
    );
  }
  const restoredManifest = JSON.parse(readFileSync(globalPackageJson, "utf8")).version;
  if (restoredManifest !== newVersion) {
    throw new Error(
      `owned package manifest stayed ${restoredManifest} after update to ${newVersion}`
    );
  }

  process.stdout.write(
    `routekit pack/install + daemon + self-update smoke passed (${closure.length} packages; ${oldVersion} → ${newVersion})\n`
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
