import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCandidateClosureComplete,
  CleanupStack,
  candidateVersionFor,
  collectPackageClosure,
  commandTimeoutMs,
  createStageLogger,
  isInstallableVersion,
  parseJsonOutput,
  privateCliInstallCommand,
  redactSensitiveText,
  rewriteManifestForCandidate,
  withRemotePath,
  writeSshConfig
} from "../lib/remote-docker-e2e.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("installable versions match the CLI allow-list", () => {
  assert.equal(isInstallableVersion("0.16.3"), true);
  assert.equal(isInstallableVersion("0.16.3-docker.abc"), true);
  assert.equal(isInstallableVersion("latest"), true);
  assert.equal(isInstallableVersion("1.0.0-rc.1"), true);
  assert.equal(isInstallableVersion("^0.16.3"), false);
  assert.equal(isInstallableVersion("next"), false);
});

test("candidate versions are distinct prereleases derived from the baseline", () => {
  assert.equal(candidateVersionFor("0.16.3", "run42"), "0.16.3-docker.run42");
  assert.equal(candidateVersionFor("0.16.3", "bad id!"), "0.16.3-docker.badid");
  assert.notEqual(
    candidateVersionFor("0.16.3", "run42.initial"),
    candidateVersionFor("0.16.3", "run42.upgrade")
  );
  assert.throws(() => candidateVersionFor("0.16.3-rc.1", "x"), /version seed/);
  assert.throws(() => candidateVersionFor("0.16.3", "@@@"), /runId/);
});

test("package closure starts at the CLI and stays inside RouteKit", () => {
  const closure = collectPackageClosure(ROOT);
  assert.ok(closure.some((entry) => entry.manifest.name === "@velum-labs/routekit"));
  assert.ok(closure.length >= 10);
  assert.equal(
    closure.every((entry) => entry.manifest.name.startsWith("@velum-labs/routekit")),
    true
  );
  assert.equal(
    closure.every((entry) => entry.manifest.private !== true),
    true
  );
});

test("manifest rewrite pins every RouteKit dependency to the candidate", () => {
  const rewritten = rewriteManifestForCandidate(
    {
      name: "@velum-labs/routekit",
      version: "0.16.3",
      dependencies: {
        "@velum-labs/routekit-runtime": "workspace:*",
        undici: "catalog:"
      },
      publishConfig: { access: "public", provenance: true }
    },
    "0.16.3-docker.test"
  );
  assert.equal(rewritten.version, "0.16.3-docker.test");
  assert.equal(rewritten.dependencies["@velum-labs/routekit-runtime"], "0.16.3-docker.test");
  assert.equal(rewritten.dependencies.undici, "catalog:");
  assert.equal(rewritten.publishConfig.provenance, undefined);
  assert.equal(rewritten.publishConfig.access, "public");
});

test("candidate closure completeness rejects missing pins", () => {
  assert.throws(
    () =>
      assertCandidateClosureComplete(
        [
          {
            manifest: {
              name: "@velum-labs/routekit",
              version: "0.16.3-docker.x",
              dependencies: { "@velum-labs/routekit-runtime": "0.16.3" }
            }
          }
        ],
        "0.16.3-docker.x"
      ),
    /missing/
  );
});

test("redaction removes join credentials and bearer tokens", () => {
  const text = redactSensitiveText(
    "peer add rk1_ABCDEFGHijklmnop Authorization: Bearer supersecrettoken OPENAI_API_KEY=docker-e2e-key",
    ["supersecrettoken"]
  );
  assert.doesNotMatch(text, /rk1_/);
  assert.match(text, /Authorization: Bearer \[redacted\]/);
  assert.match(text, /OPENAI_API_KEY=\[redacted\]/);
  assert.doesNotMatch(text, /supersecrettoken/);
});

test("command timeouts are labeled and overridable", () => {
  assert.equal(commandTimeoutMs("remoteInstall"), 600_000);
  assert.equal(commandTimeoutMs("ssh"), 30_000);
  assert.equal(commandTimeoutMs("custom", { custom: 12 }), 12);
  assert.equal(commandTimeoutMs("unknown"), 60_000);
});

test("cleanup stack runs newest first and collects failures", async () => {
  const seen = [];
  const stack = new CleanupStack();
  stack.add("one", async () => {
    seen.push("one");
  });
  stack.add("two", async () => {
    seen.push("two");
    throw new Error("boom");
  });
  stack.add("three", async () => {
    seen.push("three");
  });
  const errors = await stack.run();
  assert.deepEqual(seen, ["three", "two", "one"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /two: boom/);
});

test("ssh config writer emits BatchMode hosts", () => {
  const dir = mkdtempSync(join(tmpdir(), "rk-ssh-config-"));
  try {
    const file = join(dir, "config");
    writeSshConfig(file, {
      hosts: [
        {
          alias: "rk-docker",
          host: "127.0.0.1",
          port: 2222,
          user: "owner",
          identityFile: "/tmp/id"
        }
      ]
    });
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /Host rk-docker/);
    assert.match(contents, /BatchMode yes/);
    assert.match(contents, /Port 2222/);
    assert.match(contents, /User owner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseJsonOutput prefers the last JSON object in mixed output", () => {
  assert.deepEqual(parseJsonOutput('note\n{"ok":true}\n'), { ok: true });
  assert.throws(() => parseJsonOutput("nope"), /did not return JSON/);
});

test("withRemotePath prepends the shared PATH export", () => {
  assert.match(withRemotePath("routekit version"), /\$HOME\/\.local\/bin/);
  assert.match(withRemotePath("routekit version"), /routekit version$/);
});

test("private CLI install uses a user-owned prefix", () => {
  const command = privateCliInstallCommand("0.16.3-docker.test");
  assert.match(command, /npm config set prefix "\$HOME\/\.local"/);
  assert.match(command, /@velum-labs\/routekit@0\.16\.3-docker\.test/);
  assert.match(command, /--prefix "\$HOME\/\.local"/);
});

test("stage logger works when setStage is destructured", () => {
  // Imported lazily so the helper suite stays focused on barrel exports, but
  // still covers the destructure-safe logger used by the runner.
  return import("../lib/remote-docker/process.mjs").then(({ createStageLogger }) => {
    const stage = createStageLogger();
    const { setStage, log } = stage;
    setStage("cleanup");
    log("done");
    assert.equal(stage.name, "cleanup");
    assert.ok(stage.lines.some((line) => line.includes("stage: cleanup")));
  });
});
