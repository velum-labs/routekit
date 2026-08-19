import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const script = resolve(repoRoot, "scripts", "check-npm-release-registry.mjs");
const fixtureRoot = mkdtempSync(join(tmpdir(), "routekit-npm-release-registry-"));
const packagesRoot = resolve(fixtureRoot, "packages");
const metadata = new Map();
let registry;
let server;

function writePackage(directory, manifest) {
  const packageRoot = resolve(packagesRoot, directory);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(resolve(packageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(mode) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      script,
      mode,
      "--root",
      fixtureRoot,
      "--registry",
      registry,
      "--attempts",
      "1",
      "--delay-ms",
      "1"
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

before(async () => {
  mkdirSync(packagesRoot);
  writePackage("alpha", { name: "@velum-labs/alpha", version: "1.0.0", private: false });
  writePackage("beta", { name: "@velum-labs/beta", version: "2.0.0", private: false });
  writePackage("private", { name: "@velum-labs/private", version: "9.0.0", private: true });

  server = createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1));
    const body = metadata.get(name);
    if (body === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"Not found"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  registry = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
  );
});

test("package-name preflight fails before a trusted publish can become partial", async () => {
  metadata.set("@velum-labs/alpha", { versions: { "0.9.0": {} } });
  metadata.delete("@velum-labs/beta");

  const result = await run("names");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@velum-labs\/beta/u);
  assert.match(result.stderr, /Bootstrap each new package/u);
  assert.doesNotMatch(result.stderr, /@velum-labs\/private/u);
});

test("package-name preflight accepts existing package names regardless of version", async () => {
  metadata.set("@velum-labs/alpha", { versions: { "0.9.0": {} } });
  metadata.set("@velum-labs/beta", { versions: { "1.5.0": {} } });

  const result = await run("names");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 publishable packages/u);
});

test("release completeness requires every exact workspace version", async () => {
  metadata.set("@velum-labs/alpha", { versions: { "1.0.0": {} } });
  metadata.set("@velum-labs/beta", { versions: { "1.5.0": {} } });

  const result = await run("versions");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@velum-labs\/beta@2\.0\.0/u);
  assert.doesNotMatch(result.stderr, /@velum-labs\/alpha@1\.0\.0/u);
});

test("release completeness passes only after the full workspace is visible", async () => {
  metadata.set("@velum-labs/alpha", { versions: { "1.0.0": {} } });
  metadata.set("@velum-labs/beta", { versions: { "2.0.0": {} } });

  const result = await run("versions");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 packages at exact workspace versions/u);
});
