import { completionCandidates as coreCompletionCandidates } from "@velum-labs/routekit-cli-core";
import type * as Command from "effect/unstable/cli/Command";

import { dynamicCompletionValues } from "./effect/program.js";

export function completionCandidates(
  program: Command.Command.Any,
  words: readonly string[]
): string[] {
  return coreCompletionCandidates(program, words, dynamicCompletionValues);
}
