#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { destroyUsage, parseDestroyArgs } from "./lib/t3-routekit-deployment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const remoteHelper = readFileSync(join(here, "lib", "t3-routekit-remote.mjs"), "utf8");

function runSsh(host, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        host,
        "node",
        "--input-type=module",
        "-",
        encoded
      ],
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
          new Error(`SSH destroy helper exited with status ${code}${error ? `: ${error}` : ""}`)
        );
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error(`SSH destroy helper returned invalid JSON${error ? `: ${error}` : ""}`));
      }
    });
    child.stdin.end(remoteHelper);
  });
}

try {
  const options = parseDestroyArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write(destroyUsage());
  } else {
    const result = await runSsh(options.ssh, { action: "destroy", ...options });
    if (result.ok !== true) throw new Error(result.error ?? "remote destroy failed");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(
    `t3:destroy failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
