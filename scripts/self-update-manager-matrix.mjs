import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  packCandidateArtifacts,
  publishCandidateArtifacts,
  registerVerdaccioUser
} from "./lib/remote-docker/packaging.mjs";
import { freePort, waitForHttpOk } from "./lib/remote-docker/process.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manager = process.argv[process.argv.indexOf("--manager") + 1];
const supported = new Set(["npm", "pnpm-10", "pnpm-11", "yarn", "bun", "volta", "installer-private"]);
if (!supported.has(manager)) {
  throw new Error(`--manager must be one of ${[...supported].join(", ")}`);
}

const oldVersion = "99.0.1";
const newVersion = "99.0.2";
const temporary = realpathSync(mkdtempSync(join(tmpdir(), `routekit-self-update-${manager}-`)));
const home = join(temporary, "home");
const storage = join(temporary, "verdaccio-storage");
const config = join(temporary, "verdaccio.yaml");
mkdirSync(home, { recursive: true });
mkdirSync(storage, { recursive: true });
writeFileSync(
  config,
  [
    `storage: ${JSON.stringify(storage)}`,
    "web:",
    "  enable: false",
    "auth:",
    "  htpasswd:",
    `    file: ${JSON.stringify(join(storage, "htpasswd"))}`,
    "    max_users: 100",
    "uplinks:",
    "  npmjs:",
    "    url: https://registry.npmjs.org/",
    "packages:",
    "  '@velum-labs/*':",
    "    access: $all",
    "    publish: $all",
    "    unpublish: $all",
    "    proxy: npmjs",
    "  '**':",
    "    access: $all",
    "    publish: $all",
    "    unpublish: $all",
    "    proxy: npmjs",
    "middlewares:",
    "  audit:",
    "    enabled: false",
    "log:",
    "  type: stdout",
    "  format: pretty",
    "  level: warn",
    ""
  ].join("\n")
);

function commandPath(name) {
  const value = process.env.PATH?.split(delimiter)
    .map((directory) => join(directory, name))
    .find(existsSync);
  if (value === undefined) throw new Error(`${name} is required for the ${manager} matrix`);
  return value;
}

async function run(executable, args, options = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd ?? temporary,
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 5 * 60_000,
      maxBuffer: 16 * 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message
    };
    if (options.allowFailure === true) return result;
    throw new Error(
      `${basename(executable)} ${args.join(" ")} failed (${result.code}):\n${result.stderr || result.stdout}`
    );
  }
}

function writeWrapper(path, executable, args = [], exports = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = ["#!/bin/sh"];
  for (const [key, value] of Object.entries(exports)) {
    lines.push(`export ${key}=${JSON.stringify(value)}`);
  }
  lines.push(
    `exec ${JSON.stringify(executable)} ${args.map((value) => JSON.stringify(value)).join(" ")} "$@"`
  );
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o755 });
}

function parseJson(output, label) {
  const trimmed = output.trim();
  if (trimmed.length === 0) throw new Error(`${label} did not return JSON`);
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim() ?? "";
      if (!line.startsWith("{")) continue;
      try {
        return JSON.parse(line);
      } catch {
        // Continue scanning for an earlier compact JSON payload.
      }
    }
    throw new Error(`${label} did not return JSON:\n${output}`);
  }
}

function installLowerPriority() {
  const prefix = join(temporary, "lower-priority");
  const bin = join(prefix, "bin");
  const packageRoot = join(prefix, "lib", "node_modules", "@velum-labs", "routekit");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@velum-labs/routekit", version: oldVersion })}\n`
  );
  writeFileSync(entry, "");
  writeFileSync(
    join(bin, "routekit"),
    [
      "#!/bin/sh",
      'case "$1" in',
      `  version) printf "@velum-labs/routekit ${oldVersion}\\\\n" ;;`,
      "  __self-inspect)",
      `    printf '%s\\\\n' '${JSON.stringify({
        schemaVersion: 1,
        packageName: "@velum-labs/routekit",
        packageRoot,
        entry,
        version: oldVersion,
        processExecPath: process.execPath
      })}'`,
      "    ;;",
      "  *) exit 2 ;;",
      "esac",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  return {
    bin,
    version: () =>
      JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version
  };
}

async function installManager(registryUrl, baseEnv) {
  const specifier = `@velum-labs/routekit@${oldVersion}`;
  if (manager === "npm") {
    const prefix = join(temporary, "npm-global");
    const env = { ...baseEnv, NPM_CONFIG_PREFIX: prefix };
    await run(commandPath("npm"), [
      "install",
      "-g",
      "--registry",
      registryUrl,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      specifier
    ], { env });
    return { bin: join(prefix, "bin"), env, expectedKind: "npm" };
  }
  if (manager === "pnpm-10" || manager === "pnpm-11") {
    const pnpmHome = join(temporary, `${manager}-home`);
    const bin = manager === "pnpm-10" ? pnpmHome : join(pnpmHome, "bin");
    const version = manager === "pnpm-10" ? "10.28.0" : "11.15.1";
    const wrapper = join(bin, "pnpm");
    writeWrapper(wrapper, commandPath("corepack"), [`pnpm@${version}`]);
    const env = {
      ...baseEnv,
      PNPM_HOME: pnpmHome,
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: `${bin}${delimiter}${baseEnv.PATH}`
    };
    await run(wrapper, [
      "add",
      "-g",
      specifier,
      "--registry",
      registryUrl,
      "--config.minimum-release-age=0"
    ], { env });
    return { bin, env, expectedKind: "pnpm" };
  }
  if (manager === "yarn") {
    const prefix = join(temporary, "yarn-prefix");
    const tools = join(temporary, "yarn-tools");
    const wrapper = join(tools, "yarn");
    writeWrapper(wrapper, commandPath("corepack"), ["yarn@1.22.22"]);
    const env = {
      ...baseEnv,
      PREFIX: prefix,
      YARN_PREFIX: prefix,
      PATH: `${tools}${delimiter}${baseEnv.PATH}`
    };
    await run(wrapper, ["global", "add", specifier, "--registry", registryUrl, "--ignore-scripts"], {
      env
    });
    return { bin: join(prefix, "bin"), env, expectedKind: "yarn", tools };
  }
  if (manager === "bun") {
    const executable = commandPath("bun");
    const bunHome = join(home, ".bun");
    const bin = join(bunHome, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(executable, join(bin, "bun"));
    const env = {
      ...baseEnv,
      BUN_INSTALL: bunHome,
      PATH: `${bin}${delimiter}${baseEnv.PATH}`
    };
    await run(executable, ["add", "-g", "--exact", specifier, "--registry", registryUrl], { env });
    return { bin, env, expectedKind: "bun" };
  }
  if (manager === "volta") {
    const installedVolta = commandPath("volta");
    const installedBin = dirname(installedVolta);
    const voltaHome = join(home, ".volta");
    const bin = join(voltaHome, "bin");
    const executable = join(bin, "volta");
    mkdirSync(bin, { recursive: true });
    for (const name of ["volta", "volta-migrate", "volta-shim"]) {
      const source = join(installedBin, name);
      if (!existsSync(source)) throw new Error(`Volta installation is missing ${source}`);
      const target = join(bin, name);
      copyFileSync(source, target);
      chmodSync(target, 0o755);
    }
    const env = {
      ...baseEnv,
      VOLTA_HOME: voltaHome,
      PATH: `${bin}${delimiter}${baseEnv.PATH}`
    };
    writeFileSync(join(home, ".npmrc"), `registry=${registryUrl}\n`);
    await run(executable, ["install", "node@22.22.0"], { env });
    await run(executable, ["install", specifier], { env });
    return { bin, env, expectedKind: "volta" };
  }

  const prefix = join(home, ".local");
  const runtimeRoot = join(home, ".local", "share", "routekit", "node");
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const runtimeBin = join(runtimeRoot, `node-v22.22.2-${os}-${arch}`, "bin");
  const detectorBin = join(home, ".npm-global", "bin");
  const nodeOnlyBin = join(temporary, "node-only");
  mkdirSync(runtimeBin, { recursive: true });
  mkdirSync(detectorBin, { recursive: true });
  mkdirSync(nodeOnlyBin, { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(join(home, ".nvm"), { recursive: true });
  symlinkSync(process.execPath, join(runtimeBin, "node"));
  symlinkSync(process.execPath, join(detectorBin, "node"));
  symlinkSync(process.execPath, join(nodeOnlyBin, "node"));
  writeWrapper(join(runtimeBin, "npm"), commandPath("npm"));
  writeFileSync(
    join(detectorBin, "npm"),
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) printf "10.9.0\\n" ;;',
      '  prefix) printf "/routekit-unwritable-prefix\\n" ;;',
      "  *) exit 1 ;;",
      "esac",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  const installEnv = {
    ...baseEnv,
    HOME: home,
    ROUTEKIT_NODE_ROOT: runtimeRoot,
    ROUTEKIT_NPM_PREFIX: prefix,
    NPM_CONFIG_REGISTRY: registryUrl,
    PATH: `${detectorBin}${delimiter}/usr/local/bin${delimiter}/usr/bin${delimiter}/bin`
  };
  await run("sh", [join(root, "install.sh"), "--version", oldVersion], {
    env: installEnv,
    timeoutMs: 10 * 60_000
  });
  const receipt = JSON.parse(readFileSync(join(prefix, "lib", "routekit", "install.json"), "utf8"));
  if (receipt.installMode !== "private" || receipt.npmExecutable !== join(runtimeBin, "npm")) {
    throw new Error(`private installer wrote an invalid receipt: ${JSON.stringify(receipt)}`);
  }
  return {
    bin: join(prefix, "bin"),
    env: {
      ...baseEnv,
      HOME: home,
      NPM_CONFIG_REGISTRY: registryUrl,
      PATH: `${join(prefix, "bin")}${delimiter}${nodeOnlyBin}${delimiter}/usr/bin${delimiter}/bin`
    },
    expectedKind: "npm"
  };
}

let registry;
try {
  const port = await freePort();
  const registryUrl = `http://127.0.0.1:${port}/`;
  registry = spawn(
    commandPath("npx"),
    ["--yes", "verdaccio@6.9.1", "--config", config, "--listen", `127.0.0.1:${port}`],
    { cwd: temporary, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
  );
  // Verdaccio can emit enough request/proxy output during the packed-package
  // matrix to fill an unread child-process pipe and stop serving requests.
  registry.stdout.resume();
  registry.stderr.resume();
  await waitForHttpOk(`${registryUrl}-/ping`, { timeoutMs: 120_000 });

  const credentials = await registerVerdaccioUser(registryUrl, {
    username: `routekit-${manager.replaceAll("-", "")}`
  });
  const oldPackages = packCandidateArtifacts(root, oldVersion, join(temporary, "old"));
  const newPackages = packCandidateArtifacts(root, newVersion, join(temporary, "new"));
  await publishCandidateArtifacts(oldPackages, registryUrl, { token: credentials.token });
  await publishCandidateArtifacts(newPackages, registryUrl, { token: credentials.token });

  const baseEnv = {
    ...process.env,
    HOME: home,
    NVM_DIR: join(home, ".nvm"),
    CI: "1",
    NO_COLOR: "1",
    NPM_CONFIG_REGISTRY: registryUrl,
    npm_config_registry: registryUrl,
    PNPM_CONFIG_REGISTRY: registryUrl,
    pnpm_config_registry: registryUrl,
    PATH: [
      dirname(process.execPath),
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin"
    ].join(delimiter)
  };
  const lower = installLowerPriority();
  const active = await installManager(registryUrl, baseEnv);
  const routekit = join(active.bin, "routekit");
  if (!existsSync(routekit)) throw new Error(`${manager} did not install ${routekit}`);
  const activePath = [
    active.bin,
    active.tools,
    lower.bin,
    active.env.PATH
  ].filter(Boolean).join(delimiter);
  const env = { ...active.env, PATH: activePath };

  const dry = await run(routekit, [
    "self-update",
    "--version",
    newVersion,
    "--dry-run",
    "--json"
  ], { env });
  const dryPayload = parseJson(dry.stdout, `${manager} dry run`);
  if (
    dryPayload.action !== "planned" ||
    dryPayload.targetVersion !== newVersion ||
    dryPayload.owner?.kind !== active.expectedKind
  ) {
    throw new Error(`${manager} dry run returned ${JSON.stringify(dryPayload)}`);
  }

  const updated = await run(routekit, ["self-update", "--version", newVersion, "--json"], {
    env,
    timeoutMs: 10 * 60_000
  });
  const payload = parseJson(updated.stdout, `${manager} update`);
  if (
    payload.action !== "updated" ||
    payload.from !== oldVersion ||
    payload.to !== newVersion ||
    payload.owner?.kind !== active.expectedKind
  ) {
    throw new Error(`${manager} update returned ${JSON.stringify(payload)}`);
  }
  const fresh = await run(routekit, ["version"], { env });
  if (!fresh.stdout.includes(newVersion)) {
    throw new Error(`${manager} fresh executable did not report ${newVersion}: ${fresh.stdout}`);
  }
  if (lower.version() !== oldVersion) {
    throw new Error(`${manager} modified the lower-priority npm installation`);
  }
  process.stdout.write(
    `self-update ${manager} matrix passed (${oldVersion} -> ${newVersion}; owner=${active.expectedKind})\n`
  );
} finally {
  if (registry !== undefined && registry.exitCode === null) {
    registry.kill("SIGTERM");
    await new Promise((resolveExit) => {
      registry.once("exit", resolveExit);
      setTimeout(() => {
        if (registry.exitCode === null) registry.kill("SIGKILL");
      }, 5_000).unref();
    });
  }
  if (process.env.ROUTEKIT_KEEP_SELF_UPDATE_MATRIX !== "1") {
    rmSync(temporary, { recursive: true, force: true });
  } else {
    process.stderr.write(`kept self-update matrix artifacts at ${temporary}\n`);
  }
}
