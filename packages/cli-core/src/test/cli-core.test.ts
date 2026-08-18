import assert from "node:assert/strict";
import test from "node:test";
import { Command, Flag } from "effect/unstable/cli";

import {
  commandChildren,
  commandNames,
  commandOptions,
  effectCommandPath,
  flattenEffectCommands,
  findFlagTypos,
  formatPackageVersion,
  immutableCliRuntime,
  parseIdValue,
  parsePositiveInteger,
  processCliRuntime
} from "../index.js";

test("Effect command metadata follows the real command tree", () => {
  const remove = Command.make("remove", {
    local: Flag.boolean("local")
  }).pipe(Command.withAlias("rm"));
  const sessions = Command.make("sessions").pipe(
    Command.withAlias("session"),
    Command.withSubcommands([remove])
  );
  const root = Command.make("routekit").pipe(Command.withSubcommands([sessions]));

  assert.deepEqual(commandNames(sessions), ["sessions", "session"]);
  assert.deepEqual(commandChildren(root).map((command) => command.name), ["sessions"]);
  assert.deepEqual(commandOptions(remove).map((option) => option.name), ["local"]);
  assert.deepEqual(flattenEffectCommands(root).map((command) => command.name), [
    "sessions",
    "remove"
  ]);
  assert.equal(effectCommandPath(root, remove), "sessions remove");
});

test("shared option and flag mechanics are deterministic", () => {
  assert.deepEqual(parseIdValue("--model", "writer=openai:gpt"), {
    id: "writer",
    value: "openai:gpt"
  });
  assert.equal(parsePositiveInteger("--count", "3"), 3);
  assert.deepEqual(findFlagTypos(["--budget"], ["--buget"]), [
    { given: "--buget", suggestion: "--budget" }
  ]);
  assert.equal(
    formatPackageVersion("@velum-labs/routekit-example", "1.2.3"),
    "@velum-labs/routekit-example@1.2.3"
  );
  assert.equal(processCliRuntime.platform, process.platform);
  const runtime = immutableCliRuntime({
    stdout: process.stdout,
    stderr: process.stderr,
    env: { TEST_VALUE: "original" },
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node
  });
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(runtime.env));
});
