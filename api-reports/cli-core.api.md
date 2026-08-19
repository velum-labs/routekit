# @velum-labs/routekit-cli-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `2150bb96603a9c73a2d59c01dd35750677949e8c290ddb42040877a2bad97b08`

## Root declarations

```ts
export type { CliErrorInput } from "./errors.js";
export type { CliRuntime, CommandContext, GlobalFlags } from "./context.js";
export type { CompletionShell, CompletionValueProvider, CompletionWalk } from "./completion.js";
export type { EffectCommandArgument, EffectCommandOption } from "./effect-command.js";
export { COMPLETION_SHELLS, completionCandidates, completionScript, filterCompletionCandidates, isCompletionShell, visibleCommandNames, visibleLongFlags, walkCompletionTree } from "./completion.js";
export { CliError, cliErrorPayload, fail, renderCliError } from "./errors.js";
export { argOrPick, canPickInteractively } from "./pickers.js";
export { collect, parseIdValue, parsePort, parsePositiveInteger, parsePositiveNumber } from "./options.js";
export { commandArguments, commandChildren, commandNames, commandOptions, effectCommandPath, flattenEffectCommands, visibleCommandChildren } from "./effect-command.js";
export { contextForFlags, emitJson, immutableCliRuntime, processCliRuntime } from "./context.js";
export { findFlagTypos, knownLongFlags, levenshtein, warnPassthroughTypos } from "./flags.js";
export { formatPackageVersion, probeBinaryVersion, readPackageVersion } from "./version.js";
```
