import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("launcher passthrough sends --version to the child argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-launch-passthrough-"));
  const bin = join(root, "bin");
  const marker = join(root, "argv.txt");
  const portFile = join(root, "port.txt");
  mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\n`);
  chmodSync(claude, 0o755);
  const gatewayScript = join(root, "gateway.mjs");
  writeFileSync(
    gatewayScript,
    `import { writeFileSync } from "node:fs";\n` +
      `import { createServer } from "node:http";\n` +
      `const server = createServer((_request, response) => {\n` +
      `  response.setHeader("content-type", "application/json");\n` +
      `  response.end(JSON.stringify({ object: "list", data: [{ id: "anthropic/claude-sonnet-4-5", object: "model" }] }));\n` +
      `});\n` +
      `server.listen(0, "127.0.0.1", () => writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)));\n`
  );
  const gateway = spawn(process.execPath, [gatewayScript], { stdio: "ignore" });
  try {
    await waitForFile(portFile);
    const port = readFileSync(portFile, "utf8").trim();
    const result = spawnSync(
      process.execPath,
      [
        CLI_ENTRY,
        "claude",
        "anthropic/claude-sonnet-4-5",
        "--gateway-url",
        `http://127.0.0.1:${port}`,
        "--",
        "--version"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          ROUTEKIT_HOME: join(root, "state"),
          ROUTEKIT_TELEMETRY: "0",
          NO_COLOR: "1"
        }
      }
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const childArgv = readFileSync(marker, "utf8").trim().split("\n");
    assert.equal(childArgv.at(-1), "--version");
  } finally {
    gateway.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
