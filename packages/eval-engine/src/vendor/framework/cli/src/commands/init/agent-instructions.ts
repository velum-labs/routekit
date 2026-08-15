import { Effect, FileSystem, Path } from "effect";

import {
  FEATURE_AUTHORING_INTRO,
  formatFeatureAuthoringBullets,
} from "../../../../contracts/internal/src/feature-authoring-rules.ts";

/** Convention file most coding agents (Cursor, Codex, Claude Code, and others) read on open. */
const AGENTS_FILE_NAME = "AGENTS.md";

// The scaffolded guide is deliberately a thin pointer, not a copy of the rules.
// It is written once at init and never refreshed, so most guidance is delegated to
// the version-matched docs mirror (`.ori/docs/`) and the built-in feature-development
// skill, the same sources the runtime relies on. The one exception is the Guardrails
// section, whose bullets come straight from the shared `feature-authoring-rules`
// module — the same source the runtime injects into its own system prompt — so an
// *external* agent that never boots through the Ori harness sees the identical rules.
// Authored as an array of lines joined with newlines so the many `code spans` need no
// backtick escaping inside a template.
const AGENTS_INSTRUCTIONS = [
  "# Agent Guide",
  "",
  "This is an Ori workspace: a declarative agent (your intern) that you build by adding features under",
  "`features/`. Keep this file short. The authoritative, version-matched guidance lives in the docs below, not",
  "here, so read them rather than relying on what you remember about Ori.",
  "",
  "## Read these first",
  "",
  "- `ori <command> --help` is authoritative for every command, its flags, and its output.",
  "- If `.ori/docs/llms.txt` exists it indexes the framework docs mirrored for your installed Ori version.",
  "  It is only present when that release shipped a docs bundle, so check before relying on it.",
  "- After you run `ori dev`, Ori materializes its built-in `feature-development` skill into",
  "  `.claude/skills/feature-development/` and `.agents/skills/feature-development/` (the authoring contract and",
  "  validation workflow). Read it before adding or changing a feature.",
  "",
  "## Guardrails",
  "",
  FEATURE_AUTHORING_INTRO,
  "",
  ...formatFeatureAuthoringBullets(),
  "",
  "## Commands",
  "",
  "- `npm install` - install dependencies.",
  "- `ori dev` - run the intern locally with hot reload.",
  "- `ori features new <name>` / `ori features validate` - scaffold and check a feature.",
  "- `ori logs` - read runtime logs, including why a schedule or run failed.",
  "",
].join("\n");

/**
 * Write the agent instruction file (`AGENTS.md`) into a freshly scaffolded
 * workspace so an external coding agent inherits the same authoring rules the Ori
 * runtime injects for itself. It is created only when absent, so a persona
 * template that ships its own guide is never overwritten and a re-run is a no-op.
 * This is an ordinary committed project file, not part of the git-ignored `.ori/`
 * cache.
 */
export const writeAgentInstructions = Effect.fn(
  "ProjectInit.writeAgentInstructions"
)(function* (projectRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(projectRoot, AGENTS_FILE_NAME);
  const present = yield* fs
    .exists(target)
    .pipe(Effect.orElseSucceed(() => false));
  if (present) {
    return;
  }
  yield* fs.writeFileString(target, AGENTS_INSTRUCTIONS);
});

export { AGENTS_FILE_NAME };
