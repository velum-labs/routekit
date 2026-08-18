import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const configuration = JSON.parse(process.env.ROUTEKIT_EXPERIMENT_CONFIGURATION ?? "{}");
const mounts = JSON.parse(process.env.ROUTEKIT_EXPERIMENT_MOUNTS ?? "[]");
const inputPath = process.env.ROUTEKIT_EXPERIMENT_INPUT;
const outputPath = process.env.ROUTEKIT_EXPERIMENT_OUTPUT;
const jobDirectory = path.dirname(inputPath ?? "/vercel/sandbox/routekit-job/input.bin");
const assetRoot = path.join(jobDirectory, "assets");
const moduleRoot = process.env.CODING_ROUTER_LAB_DIST ?? "/opt/coding-router-lab/runtime/src";

const allowedModules = new Set([
  "cohort-construction-cli",
  "gitnexus-retrieval-experiment-cli",
  "luna-bounded-tool-experiment-cli",
  "luna-performance-experiment-cli",
  "oracle-snippet-materialization-cli",
  "public-pr-benchmark-cli"
]);

async function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? jobDirectory,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) =>
      resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr })
    );
  });
}

async function extractMounts() {
  await mkdir(assetRoot, { recursive: true });
  const extracted = [];
  for (const mount of mounts) {
    const filename = path.basename(mount.absolutePath);
    const destination = path.join(assetRoot, mount.path.replace(/\.tar\.zst$/u, ""));
    await mkdir(destination, { recursive: true });
    if (filename.endsWith(".tar.zst")) {
      const result = await run("tar", [
        "--zstd",
        "-xf",
        mount.absolutePath,
        "-C",
        destination,
        "--strip-components=1"
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`failed to extract ${mount.path}: ${result.stderr.slice(0, 2000)}`);
      }
    } else {
      await writeFile(path.join(destination, filename), await readFile(mount.absolutePath));
    }
    extracted.push({ artifact: mount.artifact, path: mount.path, destination, size: mount.size });
  }
  return extracted;
}

function substitute(value) {
  return value
    .replaceAll("${ASSET_ROOT}", assetRoot)
    .replaceAll("${JOB_DIRECTORY}", jobDirectory)
    .replaceAll("${INPUT}", inputPath ?? "")
    .replaceAll("${OUTPUT}", outputPath ?? "");
}

const operation = configuration.operation ?? "inspect";
const extracted = await extractMounts();
let output;
if (operation === "inspect") {
  output = {
    runner: "routekit-coding-router-v1",
    gitVersion: (await run("git", ["--version"])).stdout.trim(),
    gitNexusVersion: (await run("gitnexus", ["--version"])).stdout.trim(),
    extracted
  };
} else if (operation === "module") {
  const moduleName = configuration.module;
  if (typeof moduleName !== "string" || !allowedModules.has(moduleName)) {
    throw new Error(`unsupported coding-router module ${JSON.stringify(moduleName)}`);
  }
  const args = Array.isArray(configuration.args)
    ? configuration.args.map((value) => {
        if (typeof value !== "string") throw new Error("module args must be strings");
        return substitute(value);
      })
    : [];
  const result = await run("node", [path.join(moduleRoot, `${moduleName}.js`), ...args], {
    env: { ROUTEKIT_ASSET_ROOT: assetRoot }
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `coding-router module failed (${result.exitCode}): ${result.stderr.slice(0, 4000)}`
    );
  }
  output = {
    runner: "routekit-coding-router-v1",
    module: moduleName,
    stdout: result.stdout,
    stderr: result.stderr,
    extracted
  };
} else {
  throw new Error(`unsupported runner operation ${JSON.stringify(operation)}`);
}

const text = `${JSON.stringify(output, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, text);
process.stdout.write(text);
