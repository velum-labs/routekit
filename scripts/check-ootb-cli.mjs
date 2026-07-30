// OOTB shape smoke for the published RouteKit CLI. Guards bin name, ownership
// boundaries, top-level command surfaces, and packaged files without needing a
// real npm publish. Run after `pnpm build`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUTE_CLI = "packages/cli/dist/index.js";

const fail = (message) => {
  console.error(`ootb cli check failed: ${message}`);
  process.exitCode = 1;
};

function runCli(cli, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function helpHasCommand(output, command) {
  return new RegExp(`^  ${command}(?:[ <\\[]|$)`, "m").test(output);
}

const routeHelp = runCli(ROUTE_CLI, ["--help"]);
if (routeHelp.status !== 0) fail(`\`routekit --help\` exited ${routeHelp.status}`);
if (!routeHelp.stdout.startsWith("Usage: routekit ")) {
  fail("RouteKit help does not identify the routekit executable");
}
for (const command of [
  "start",
  "status",
  "stop",
  "codex",
  "claude",
  "cursor",
  "accounts",
  "providers",
  "usage",
  "models",
  "sessions",
  "config",
  "doctor",
  "self-update",
  "telemetry",
  "version",
  "completion"
]) {
  if (!helpHasCommand(routeHelp.stdout, command)) {
    fail(`RouteKit help is missing command "${command}"`);
  }
}
for (const advanced of ["gateway", "daemon"]) {
  if (helpHasCommand(routeHelp.stdout, advanced)) {
    fail(`RouteKit help exposes advanced lifecycle surface "${advanced}"`);
  }
}
for (const notOffered of ["opencode", "google", "gemini", "grok", "kimi", "cliproxy"]) {
  if (new RegExp(`\\b${notOffered}\\b`, "i").test(routeHelp.stdout)) {
    fail(`RouteKit help exposes not-offered route "${notOffered}"`);
  }
}
const gatewayProbe = runCli(ROUTE_CLI, ["gateway", "serve"]);
if (gatewayProbe.status === 0 || !gatewayProbe.stderr.includes("unknown command")) {
  fail("`routekit gateway serve` unexpectedly still exists");
}
const daemonHelp = runCli(ROUTE_CLI, ["daemon", "--help"]);
if (daemonHelp.status !== 0) fail(`\`routekit daemon --help\` exited ${daemonHelp.status}`);
for (const command of [
  "start",
  "status",
  "reload",
  "restart",
  "upgrade",
  "stop",
  "logs",
  "auth",
  "service"
]) {
  if (!helpHasCommand(daemonHelp.stdout, command)) {
    fail(`RouteKit daemon help is missing command "${command}"`);
  }
}
for (const removed of ["endpoints", "install", "uninstall"]) {
  if (helpHasCommand(routeHelp.stdout, removed)) {
    fail(`RouteKit help unexpectedly includes removed alias "${removed}"`);
  }
}
const serviceHelp = runCli(ROUTE_CLI, ["daemon", "service", "--help"]);
for (const command of ["install", "status", "uninstall"]) {
  if (!helpHasCommand(serviceHelp.stdout, command)) {
    fail(`RouteKit daemon service help is missing command "${command}"`);
  }
}
const sessionsHelp = runCli(ROUTE_CLI, ["sessions", "--help"]);
if (sessionsHelp.status !== 0) fail(`\`routekit sessions --help\` exited ${sessionsHelp.status}`);
for (const command of ["list", "show", "rm|remove"]) {
  if (!helpHasCommand(sessionsHelp.stdout, command)) {
    fail(`RouteKit sessions help is missing command "${command}"`);
  }
}
for (const fusionOnly of ["setup", "prompts", "ensemble"]) {
  if (helpHasCommand(routeHelp.stdout, fusionOnly)) {
    fail(`RouteKit help unexpectedly includes Fusion-owned surface "${fusionOnly}"`);
  }
}

const routekitRoot = mkdtempSync(join(tmpdir(), "routekit-ootb-"));
const routekitProject = join(routekitRoot, "project");
const routekitConfig = join(routekitProject, "router.yaml");
mkdirSync(routekitProject, { recursive: true });
writeFileSync(
  routekitConfig,
  [
    "endpoints:",
    "  - endpointId: ootb",
    "    model: provider-private",
    "    baseUrl: http://127.0.0.1:9/v1",
    "defaultEndpointId: ootb",
    ""
  ].join("\n")
);
try {
  const routekitEnv = {
    HOME: routekitRoot,
    ROUTEKIT_HOME: join(routekitRoot, "state"),
    ROUTEKIT_TELEMETRY: "0",
    PORTLESS: "0",
    PATH: "/nonexistent",
    NO_COLOR: "1"
  };
  const doctor = runCli(ROUTE_CLI, ["--config", routekitConfig, "doctor", "--json"], routekitEnv);
  if (doctor.status !== 1) fail(`\`routekit doctor --json\` exited ${doctor.status}, expected 1`);
  try {
    const diagnosis = JSON.parse(doctor.stdout);
    if (diagnosis.ready !== false)
      fail("RouteKit doctor must report ready:false without harnesses");
    if (!diagnosis.checks?.some((check) => check.label === "router config" && check.ok === true)) {
      fail("RouteKit doctor did not validate its router config");
    }
    if (!diagnosis.checks?.some((check) => check.label === "codex" && check.ok === false)) {
      fail("RouteKit doctor did not report the missing Codex harness");
    }
  } catch (error) {
    fail(
      `RouteKit doctor did not emit valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }

  const missingHarness = runCli(ROUTE_CLI, ["codex", "ootb"], routekitEnv);
  if (missingHarness.status === 0) {
    fail("`routekit codex` unexpectedly succeeded with no Codex harness");
  }
  const missingHarnessOutput = `${missingHarness.stdout}${missingHarness.stderr}`;
  if (
    !missingHarnessOutput.includes("routekit preflight failed") ||
    !missingHarnessOutput.includes('"codex" was not found on PATH')
  ) {
    fail(`expected an actionable RouteKit harness preflight, got:\n${missingHarnessOutput}`);
  }
} finally {
  rmSync(routekitRoot, { recursive: true, force: true });
}

const pkg = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
if (pkg.name !== "@velum-labs/routekit") {
  fail(`packages/cli/package.json name must be "@velum-labs/routekit", got "${pkg.name}"`);
}
if (pkg.bin?.routekit !== "./dist/index.js") {
  fail("@velum-labs/routekit must expose `routekit -> ./dist/index.js`");
}
if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
  fail("@velum-labs/routekit must publish its dist directory");
}
if (!pkg.files.includes("LICENSE")) fail("@velum-labs/routekit must publish LICENSE");
if (pkg.private !== false) fail("@velum-labs/routekit must be publishable (private:false)");

if (process.exitCode) process.exit(process.exitCode);
console.log("ootb cli check passed");
