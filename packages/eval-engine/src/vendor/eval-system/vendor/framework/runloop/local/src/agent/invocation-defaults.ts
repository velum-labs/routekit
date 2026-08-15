import { Effect } from "effect";

import type { AgentRunnerCommand } from "../agent-runner/service.ts";
import type { FeatureRuntimeShape } from "../feature-runtime/service.ts";

import { DEFAULT_REASONING_EFFORT } from "../../../../contracts/author/src/index.ts";
import { ContextWindowLookup } from "../models/context-window.ts";

type FeatureRuntimeBootResult =
  ReturnType<FeatureRuntimeShape["boot"]> extends Effect.Effect<
    infer Success,
    unknown,
    unknown
  >
    ? Success
    : never;

// The default model is a static slug from the root `routekit-eval.md` frontmatter (RFC
// 0002 root-persona.md). A CLI `--model` override wins; otherwise look up the single
// `BuiltinName.Model` registry entry. No per-invocation resolution, so this is sync.
const resolveModel = (
  boot: FeatureRuntimeBootResult,
  command: AgentRunnerCommand
): string | null | undefined =>
  command.model === undefined ? boot.modelRegistry.resolve() : command.model;

// Resolved here rather than in the chat TUI so every caller — evals, Slack, the
// API, scheduled runs — gets the same bundled effort, which is what lets an eval
// hold effort constant across candidates (ROUTEKIT_EVAL-685).
//
// A caller that sends any `parameters` at all has already decided: the chat TUI
// sends `{ reasoning: {} }` for a model whose catalog entry advertises no
// reasoning, and that must stay empty rather than be refilled with the default.
//
// Headless callers send nothing, so the catalog check happens here instead. It
// is the same check the TUI picker makes, just moved to where the callers that
// have no picker can benefit from it: a model the catalog says does not reason
// gets no effort rather than a `high` its provider never asked for.
//
// Only a catalog entry that says so counts: an unavailable catalog, or an id it
// has never listed, leaves the default in place. That deliberately includes the
// window before the catalog first loads, so a turn fired at daemon boot can take
// the bundled default where the same turn a moment later takes the model's own.
// Silence is not evidence, and blocking every first turn on a network fetch is
// the worse trade; an eval that needs the level pinned should send `parameters`,
// which returns above without consulting the catalog at all.
const resolveParameters = Effect.fn("AgentRunner.resolveParameters")(function* (
  command: AgentRunnerCommand,
  model: string | null | undefined
) {
  if (command.parameters !== undefined) {
    return command.parameters;
  }
  const effort = yield* (yield* ContextWindowLookup).effortFor(model);
  if (effort === null) {
    return { reasoning: {} };
  }
  // The catalog's own default when it published one, so an eval on a model
  // offering ["low","medium"] does not get a `high` its provider will reject.
  return { reasoning: { effort: effort ?? DEFAULT_REASONING_EFFORT } };
});

export { resolveModel, resolveParameters };
export type { FeatureRuntimeBootResult };
