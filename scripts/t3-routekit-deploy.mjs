#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDesktopSshRemote } from "./lib/t3-code-desktop-remote.mjs";
import {
  DEFAULT_T3_SSH_REMOTE,
  deployUsage,
  parseDeployArgs
} from "./lib/t3-routekit-deployment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const remoteHelper = readFileSync(join(here, "lib", "t3-routekit-remote.mjs"), "utf8");
const linuxRemoteHelper = readFileSync(join(here, "lib", "t3-routekit-linux-remote.mjs"), "utf8");
const SAFE_LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

function sshCapture(host, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host, command],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      reject(
        new Error(`SSH platform probe failed: ${Buffer.concat(stderr).toString("utf8").trim()}`)
      );
    });
  });
}

async function ensureLinuxLinger(host, requestedUser) {
  const serviceUser = requestedUser ?? (await sshCapture(host, "/usr/bin/id -un"));
  if (!SAFE_LINUX_USER.test(serviceUser))
    throw new Error("Linux service user contains unsupported characters");
  const showCommand = `/usr/bin/loginctl show-user ${serviceUser} --property=Linger --value`;
  let linger = "no";
  try {
    linger = await sshCapture(host, showCommand);
  } catch {
    // A service account with no login session and no lingering has no
    // logind user record yet. Enabling linger below creates it.
  }
  if (linger === "yes") return serviceUser;
  try {
    await sshCapture(
      host,
      `/usr/bin/sudo -n /usr/bin/loginctl enable-linger ${serviceUser} && ${showCommand}`
    );
  } catch (error) {
    throw new Error(
      `could not enable systemd lingering for ${serviceUser} through passwordless sudo: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if ((await sshCapture(host, showCommand)) !== "yes")
    throw new Error(`systemd lingering is not enabled for ${serviceUser}`);
  return serviceUser;
}

async function runSsh(host, payload) {
  const platform = await sshCapture(host, "uname -s");
  const linux = platform === "Linux";
  if (!linux && platform !== "Darwin")
    throw new Error(`unsupported SSH target platform: ${platform}`);
  if (linux && payload.headless)
    throw new Error("--headless/--sudo-user are macOS-only; use --service-user on Linux");
  if (!linux && payload.serviceUser !== undefined)
    throw new Error("--service-user is supported only on Linux targets");
  if (linux && payload.dryRun !== true) await ensureLinuxLinger(host, payload.serviceUser);
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const helperCommand =
    linux && payload.serviceUser !== undefined
      ? [
          "/usr/bin/sudo",
          "-n",
          "-H",
          "-u",
          payload.serviceUser,
          "/usr/bin/env",
          "PATH=/opt/routekit/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          "node",
          "--input-type=module",
          "-",
          encoded
        ]
      : payload.headless
        ? [
            "/usr/bin/sudo",
            "-n",
            "-H",
            "/usr/bin/env",
            "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "node",
            "--input-type=module",
            "-",
            encoded
          ]
        : ["node", "--input-type=module", "-", encoded];
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host, ...helperCommand],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const stdout = [];
    const stderr = [];
    child.on("error", reject);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(
          new Error(`SSH deployment helper exited with status ${code}${error ? `: ${error}` : ""}`)
        );
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(
          new Error(`SSH deployment helper returned invalid JSON${error ? `: ${error}` : ""}`)
        );
      }
    });
    child.stdin.end(linux ? linuxRemoteHelper : remoteHelper);
  });
}

function runLocal(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-", encoded], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.on("error", reject);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(
          new Error(
            `local deployment helper exited with status ${code}${error ? `: ${error}` : ""}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(
          new Error(`local deployment helper returned invalid JSON${error ? `: ${error}` : ""}`)
        );
      }
    });
    child.stdin.end(remoteHelper);
  });
}

try {
  const options = parseDeployArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write(deployUsage());
  } else {
    const result = await (options.local
      ? runLocal({ action: "deploy", ...options })
      : runSsh(options.ssh, { action: "deploy", ...options }));
    if (result.ok !== true) throw new Error(result.error ?? "remote deployment failed");
    if (options.local) {
      result.desktopRemote = await ensureDesktopSshRemote(DEFAULT_T3_SSH_REMOTE, {
        dryRun: options.dryRun
      });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(
    `t3:deploy failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
