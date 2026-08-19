import assert from "node:assert/strict";
import test from "node:test";

import { Command, Flag } from "effect/unstable/cli";

import {
  completionCandidates,
  completionScript,
  filterCompletionCandidates,
  visibleCommandNames,
  visibleLongFlags,
  walkCompletionTree
} from "../completion.js";

function commandTree(): Command.Command.Any {
  const remove = Command.make("remove").pipe(Command.withAlias("rm"));
  const sessions = Command.make("sessions", {
    local: Flag.boolean("local")
  }).pipe(Command.withAlias("session"), Command.withSubcommands([remove]));
  const internal = Command.make("internal").pipe(Command.unlisted);
  return Command.make("example", {
    json: Flag.boolean("json"),
    internalToken: Flag.string("internal-token").pipe(Flag.withHidden)
  }).pipe(Command.withSubcommands([sessions, internal]));
}

test("completion helpers expose visible aliases and inherited long flags", () => {
  const program = commandTree();
  const state = walkCompletionTree(program, ["session", "rm", ""]);

  assert.deepEqual(visibleCommandNames(program), ["sessions", "session"]);
  assert.deepEqual(visibleLongFlags(state.ancestry).sort(), ["--json", "--local"]);
  assert.doesNotMatch(completionScript("bash", "example", program), /\binternal\b/);
});

test("completion tree walking resolves aliases to canonical paths", () => {
  const state = walkCompletionTree(commandTree(), ["session", "rm", "alpha", "be"]);

  assert.equal(state.command.name, "remove");
  assert.deepEqual(state.path, ["sessions", "remove"]);
  assert.deepEqual(state.positional, ["alpha"]);
  assert.equal(state.argumentDepth, 1);
  assert.equal(state.currentWord, "be");
});

test("candidate filtering de-duplicates, prefix-filters, and sorts", () => {
  assert.deepEqual(
    filterCompletionCandidates(["beta", "alpha", "alpine", "alpha"], "al"),
    ["alpha", "alpine"]
  );
});

test("completion candidates combine the command tree with dynamic values", () => {
  const program = commandTree();

  assert.deepEqual(completionCandidates(program, ["ses"]), ["session", "sessions"]);
  assert.deepEqual(
    completionCandidates(program, ["session", "rm", "--"]),
    ["--json", "--local"]
  );
  assert.deepEqual(
    completionCandidates(program, ["session", "rm", "a"], (path, depth, positional) => {
      assert.deepEqual(path, ["sessions", "remove"]);
      assert.equal(depth, 0);
      assert.deepEqual(positional, []);
      return ["alpha", "beta"];
    }),
    ["alpha"]
  );
  assert.match(completionScript("bash", "example", program), /sessions\|session\)/);
});
