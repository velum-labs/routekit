import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  commandChildren,
  commandNames,
  commandOptions,
  immutableCliRuntime,
  visibleCommandChildren
} from "@velum-labs/routekit-cli-core";
import { buildProgram } from "../cli.js";
import { child, runProgram } from "./effect-cli-test.js";
import { completionCandidates } from "../completion.js";

const FORBIDDEN_PRODUCT = ["fu", "sion", "kit"].join("");
const FORBIDDEN_SCOPE = `@${FORBIDDEN_PRODUCT}/`;
const foreignDependencyPattern = new RegExp(
  `${FORBIDDEN_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${FORBIDDEN_PRODUCT}|${FORBIDDEN_PRODUCT.toUpperCase()}`,
  "i"
);

function command(program: ReturnType<typeof buildProgram>, name: string) {
  return child(program, name);
}

function productionSources(directory: string): string[] {
  const sources: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name !== "test") sources.push(...productionSources(path));
    } else if (name.endsWith(".ts")) {
      sources.push(readFileSync(path, "utf8"));
    }
  }
  return sources;
}

test("independent command surface is complete and has no compatibility aliases", () => {
  const program = buildProgram();
  const expected = [
    "daemon",
    "start",
    "stop",
    "codex",
    "claude",
    "status",
    "usage",
    "leaderboard",
    "calls",
    "accounts",
    "providers",
    "remote",
    "peer",
    "token",
    "models",
    "config",
    "credential",
    "setup",
    "doctor",
    "eval",
    "policy",
    "self-update",
    "telemetry",
    "completion",
    "__complete",
    "__self-inspect",
    "version"
  ];
  assert.deepEqual(commandChildren(program).map((entry) => entry.name).sort(), expected.sort());
  assert.equal(
    commandChildren(program).some((entry) => entry.name === "gateway"),
    false
  );
  assert.deepEqual(
    command(program, "daemon")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["auth", "exec", "logs", "reload", "restart", "run", "service", "upgrade"]
  );
  assert.deepEqual(
    command(program, "daemon")
      .subcommands.flatMap((group) => group.commands).find((entry) => entry.name === "service")
      ?.subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["install", "status", "uninstall"]
  );
  assert.deepEqual(
    command(program, "codex")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["install", "uninstall"]
  );
  assert.deepEqual(
    command(program, "claude")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["install", "uninstall"]
  );
  assert.equal(
    commandChildren(program).some((entry) => entry.name === "cursor"),
    false
  );
  // One connector-neutral account surface: no cliproxy (or other
  // implementation-detail) subtree is exposed.
  assert.deepEqual(
    command(program, "accounts")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["add", "list", "login", "remove", "rename", "status"]
  );
  assert.deepEqual(
    command(program, "providers")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["add", "remove", "status"]
  );
  assert.deepEqual(
    command(program, "remote")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["add", "install", "list", "remove", "show", "use"]
  );
  assert.deepEqual(
    command(program, "models")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["info", "list"]
  );
  assert.deepEqual(
    command(program, "calls")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["inspect"]
  );
  assert.deepEqual(
    command(program, "config")
      .subcommands.flatMap((group) => group.commands).map((entry) => entry.name)
      .sort(),
    ["edit", "import", "init", "path", "show"]
  );
  assert.equal(
    commandChildren(program).some((entry) => commandNames(entry).length > 1),
    false
  );
});

test("top-level help presents one public RouteKit lifecycle", () => {
  const names = visibleCommandChildren(buildProgram()).map((entry) => entry.name);
  for (const name of ["start", "status", "stop"]) assert.ok(names.includes(name));
  assert.equal(names.includes("daemon"), false);
  assert.equal(names.includes("gateway"), false);
});

test("config help describes import-only singleton policy", () => {
  const program = buildProgram();
  const globalConfig = commandOptions(program).find((option) => option.name === "config");
  assert.equal(globalConfig, undefined);

  const config = command(program, "config");
  const init = child(config, "init");
  const edit = child(config, "edit");
  const importCommand = child(config, "import");
  assert.equal(commandOptions(init).find((option) => option.name === "global")?.hidden, true);
  assert.ok(commandOptions(init).some((option) => option.name === "provider"));
  assert.ok(commandOptions(init).some((option) => option.name === "default-model"));
  assert.ok(commandOptions(init).some((option) => option.name === "empty"));
  assert.equal(commandOptions(edit).find((option) => option.name === "global")?.hidden, true);
  assert.match(importCommand.description ?? "", /replace the canonical singleton config/);
});

test("CLI metadata preserves negative flags and optional watch values", () => {
  const program = buildProgram();
  const start = command(program, "start");
  const remote = command(program, "remote");
  const add = child(remote, "add");
  const install = child(remote, "install");
  const status = command(program, "status");
  const usage = command(program, "usage");

  assert.equal(commandOptions(start).find((option) => option.name === "no-portless")?.negated, true);
  assert.equal(commandOptions(add).find((option) => option.name === "no-use")?.negated, true);
  assert.equal(commandOptions(install).find((option) => option.name === "no-use")?.negated, true);
  for (const watchCommand of [status, usage]) {
    const watch = commandOptions(watchCommand).find((option) => option.name === "watch");
    assert.equal(watch?.valueName, "seconds");
    assert.equal(watch?.valueOptional, true);
  }
});

test("dynamic completion follows the command tree", () => {
  const program = buildProgram();
  const topLevel = completionCandidates(program, [""]);
  assert.ok(topLevel.includes("start"));
  assert.ok(topLevel.includes("status"));
  assert.ok(topLevel.includes("stop"));
  assert.equal(topLevel.includes("daemon"), false);
  assert.equal(topLevel.includes("gateway"), false);
  assert.ok(completionCandidates(program, ["co"]).includes("config"));
  assert.ok(completionCandidates(program, ["re"]).includes("remote"));
  assert.deepEqual(completionCandidates(program, ["accounts", "s"]), ["status"]);
  assert.ok(completionCandidates(program, ["codex", "in"]).includes("install"));
  assert.ok(completionCandidates(program, ["claude", "in"]).includes("install"));
  assert.ok(completionCandidates(program, ["start", "--p"]).includes("--port"));
  assert.deepEqual(completionCandidates(program, ["accounts", "remove", ""]), [
    "claude-code",
    "codex"
  ]);
  assert.deepEqual(completionCandidates(program, ["accounts", "rename", ""]), [
    "claude-code",
    "codex"
  ]);
  assert.deepEqual(completionCandidates(program, ["accounts", "login", "a"]), []);
  assert.deepEqual(completionCandidates(program, ["accounts", "add", ""]), [
    "claude-code",
    "codex"
  ]);
});

test("Effect adapters write through the injected immutable runtime", async () => {
  const stdout: string[] = [];
  const runtime = immutableCliRuntime({
    stdout: { write: (value) => (stdout.push(String(value)), true) },
    stderr: { write: () => true },
    env: {},
    platform: "linux",
    arch: "x64",
    nodeVersion: "22.22.2"
  });

  await runProgram(buildProgram(runtime), ["completion", "bash"]);
  assert.match(stdout.join(""), /routekit/);

  stdout.length = 0;
  await runProgram(buildProgram(runtime), ["__complete", "--", "sta"]);
  assert.equal(stdout.join(""), "start\nstatus\n");
});

test("native client installs use RouteKit-managed dedicated credentials", () => {
  const program = buildProgram();
  for (const tool of ["codex", "claude"]) {
    const install = child(command(program, tool), "install");
    assert.ok(commandOptions(install).some((option) => option.name === "rotate-token"));
    assert.ok(commandOptions(install).some((option) => option.name === "no-token"));
    assert.equal(
      commandOptions(install).some((option) => option.name === "shell"),
      false
    );
    assert.equal(
      commandOptions(install).some((option) => option.name === "gateway-url"),
      false
    );
    assert.equal(
      commandOptions(install).some((option) => option.name === "auth-token-env"),
      false
    );
  }
});

test("start CLI documents explicit data-plane authentication", () => {
  const program = buildProgram();
  const start = child(program, "start");
  assert.match(
    commandOptions(start).find((option) => option.name === "auth-token")?.description ?? "",
    /authentication token/
  );
});

test("account removal completion only suggests managed labels for its provider", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-completion-"));
  const previousHome = process.env.ROUTEKIT_HOME;
  mkdirSync(join(root, "subscriptions", "codex"), { recursive: true });
  mkdirSync(join(root, "cliproxy", "auth"), { recursive: true });
  writeFileSync(join(root, "subscriptions", "codex", "work.json"), "{}\n");
  writeFileSync(
    join(root, "cliproxy", "auth", "antigravity-user@example.com.json"),
    JSON.stringify({ type: "antigravity" })
  );
  writeFileSync(join(root, "cliproxy", "auth", "mystery-blob.json"), "{not-json");
  process.env.ROUTEKIT_HOME = root;
  try {
    assert.deepEqual(completionCandidates(buildProgram(), ["accounts", "remove", "codex", "w"]), [
      "work"
    ]);
    assert.deepEqual(completionCandidates(buildProgram(), ["accounts", "rename", "codex", "w"]), [
      "work"
    ]);
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "rename", "claude-code", "w"]),
      []
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "claude-code", "w"]),
      []
    );
    // Retained internal connector state never leaks into public completion.
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "antigravity", "a"]),
      []
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "gemini", "a"]),
      []
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "mystery", "m"]),
      []
    );
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("production graph and sources stay within RouteKit scope", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(here, "..", "..");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith("@velum-labs/routekit")) {
      assert.equal(version, "workspace:*", name);
      continue;
    }
    assert.equal(version, "catalog:", name);
  }
  const sourceRoot = join(packageRoot, "src");
  const production = productionSources(sourceRoot).join("\n");
  assert.equal(foreignDependencyPattern.test(production), false);
});
