#!/usr/bin/env node
/**
 * PATH-faked launchctl/systemctl for supervised daemon lifecycle tests.
 * Env:
 *   FAKE_SUPERVISOR_HOME  — HOME used when the unit/plist was written
 *   FAKE_SUPERVISOR_STATE — JSON file tracking the supervised child pid
 *   FAKE_SUPERVISOR_KIND  — "launchd" | "systemd"
 *   FAKE_SUPERVISOR_ENV   — JSON object inherited by the supervised child
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.FAKE_SUPERVISOR_HOME;
const statePath = process.env.FAKE_SUPERVISOR_STATE;
const kind = process.env.FAKE_SUPERVISOR_KIND;
const managerEnv = JSON.parse(process.env.FAKE_SUPERVISOR_ENV ?? "{}");
const argv = process.argv.slice(2);

if (home === undefined || statePath === undefined || kind === undefined) {
  process.stderr.write("fake supervisor missing required environment\n");
  process.exit(1);
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state));
}

function alive(pid) {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Busy-wait; this fake only runs inside hermetic tests.
  }
}

function stopChild() {
  const state = readState();
  if (alive(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already exiting
    }
    const deadline = Date.now() + 5_000;
    while (alive(state.pid) && Date.now() < deadline) sleep(20);
    if (alive(state.pid)) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  writeState({});
}

function unescapeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

function decodeSystemdToken(token) {
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replaceAll(String.raw`\\`, "\\").replaceAll(String.raw`\"`, '"');
  }
  return token;
}

function tokenizeExecStart(line) {
  const tokens = [];
  const raw = line.slice("ExecStart=".length);
  const re = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  for (const match of raw.matchAll(re)) {
    tokens.push(match[1] !== undefined ? match[1].replaceAll(/\\([\\"])/g, "$1") : match[2]);
  }
  return tokens;
}

function startFromUnit() {
  stopChild();
  let execPath;
  let args = [];
  const env = { ...process.env, ...managerEnv };
  if (kind === "launchd") {
    const plist = readFileSync(
      join(home, "Library", "LaunchAgents", "com.routekit.daemon.plist"),
      "utf8"
    );
    const programSection =
      plist.split("<key>ProgramArguments</key>")[1]?.split("</array>")[0] ?? "";
    args = [...programSection.matchAll(/<string>([^<]*)<\/string>/g)].map((match) =>
      unescapeXml(match[1] ?? "")
    );
    execPath = args.shift();
    const envSection = plist.split("<key>EnvironmentVariables</key>")[1]?.split("</dict>")[0] ?? "";
    for (const match of envSection.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
      env[match[1] ?? ""] = unescapeXml(match[2] ?? "");
    }
  } else {
    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "routekit-daemon.service"),
      "utf8"
    );
    const execLine = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    if (execLine === undefined) {
      process.stderr.write("missing ExecStart\n");
      process.exit(1);
    }
    const tokens = tokenizeExecStart(execLine);
    execPath = tokens.shift();
    args = tokens;
    const envFile = unit
      .split("\n")
      .find((line) => line.startsWith("EnvironmentFile=-"))
      ?.slice("EnvironmentFile=-".length);
    if (envFile !== undefined && existsSync(envFile)) {
      for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        env[line.slice(0, eq)] = decodeSystemdToken(line.slice(eq + 1));
      }
    }
    for (const line of unit.split("\n")) {
      if (!line.startsWith("Environment=")) continue;
      const assignment = decodeSystemdToken(line.slice("Environment=".length));
      const eq = assignment.indexOf("=");
      if (eq > 0) env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
    }
  }
  if (execPath === undefined) {
    process.stderr.write("supervisor fake could not parse unit command\n");
    process.exit(1);
  }
  const child = spawn(execPath, args, { env, detached: true, stdio: "ignore" });
  child.unref();
  writeState({ pid: child.pid });
}

if (kind === "launchd") {
  if (argv[0] === "version") process.exit(0);
  if (argv[0] === "bootout") {
    stopChild();
    process.exit(0);
  }
  if (argv[0] === "bootstrap") {
    startFromUnit();
    process.exit(0);
  }
  if (argv[0] === "enable") process.exit(0);
  if (argv[0] === "print") process.exit(alive(readState().pid) ? 0 : 1);
  process.stderr.write(`unexpected launchctl ${argv.join(" ")}\n`);
  process.exit(1);
}

if (argv[0] === "--user" && argv[1] === "is-system-running") {
  process.stdout.write("running\n");
  process.exit(0);
}
if (argv[0] === "--user" && argv[1] === "daemon-reload") process.exit(0);
if (argv[0] === "--user" && argv[1] === "enable") process.exit(0);
if (argv[0] === "--user" && (argv[1] === "start" || argv[1] === "restart")) {
  startFromUnit();
  process.exit(0);
}
if (argv[0] === "--user" && (argv[1] === "stop" || argv[1] === "disable")) {
  stopChild();
  process.exit(0);
}
if (argv[0] === "--user" && argv[1] === "is-active") {
  const active = alive(readState().pid);
  process.stdout.write(active ? "active\n" : "inactive\n");
  process.exit(active ? 0 : 1);
}
process.stderr.write(`unexpected systemctl ${argv.join(" ")}\n`);
process.exit(1);
