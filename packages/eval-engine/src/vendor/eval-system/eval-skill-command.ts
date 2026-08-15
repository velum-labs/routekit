import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { CliIo } from "./vendor/framework/contracts/internal/src/cli/cli-io.ts";
import { renderEnvelope } from "./vendor/framework/contracts/internal/src/cli/cli-output.ts";
import { currentOutputMode } from "./vendor/framework/contracts/internal/src/cli/output-mode.ts";
import { CliFailureError } from "./vendor/framework/contracts/internal/src/errors.ts";
import { reportCommandFailure } from "./vendor/framework/cli/src/command-failure.ts";

import { CREATE_EVAL_SKILL_NAME, resolveCreateEvalSkillEntries } from "./product-code-assets";

const EVAL_SKILL_COMMAND_LABEL = "eval skill";
const NO_EXCLUDED_SKILLS: ReadonlySet<string> = new Set();
interface SkillsGetResult {
  readonly aliases?: readonly string[];
  readonly body: string;
  readonly description: string;
  readonly name: string;
}

/**
 * Focused `eval skill` surface for the extracted product.
 *
 * It reads the exact same embedded create-eval asset used by the runtime
 * catalog, without importing RouteKitEval's catalog of unrelated code skills.
 */
export const evalSystemSkillCommand = Command.make("skill", {}, () =>
  Effect.gen(function* () {
    const cliIo = yield* CliIo;
    const entries = yield* resolveCreateEvalSkillEntries(NO_EXCLUDED_SKILLS);
    const skill = entries.find((entry) => entry.name === CREATE_EVAL_SKILL_NAME);

    if (skill === undefined) {
      return yield* new CliFailureError({
        detail: `The eval system has no "${CREATE_EVAL_SKILL_NAME}" entry.`,
        hint: "This is a build defect: the skill is compiled into the executable.",
      });
    }

    if ((yield* currentOutputMode()) === "json") {
      const result: SkillsGetResult = {
        ...(skill.commandAliases?.length ? { aliases: skill.commandAliases } : {}),
        body: skill.body,
        description: skill.description,
        name: skill.name,
      };
      yield* cliIo.writeStdout(renderEnvelope(EVAL_SKILL_COMMAND_LABEL, result));
      return;
    }

    yield* cliIo.writeStdout(skill.body);
  }).pipe(reportCommandFailure(EVAL_SKILL_COMMAND_LABEL)),
).pipe(Command.withDescription("Print the embedded skill that teaches how to write an eval file."));
