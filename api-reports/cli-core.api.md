# @velum-labs/routekit-cli-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `84d41d97096abf9bb52c7c449a5bda367a0b808bed5d89495bb602b4b87bd587`

## Root declarations

```ts
export type { CliErrorInput } from "./errors.js";
export type { CliRuntime, CommandContext, GlobalFlags } from "./context.js";
export type { CompletionShell, CompletionValueProvider, CompletionWalk } from "./completion.js";
export { COMPLETION_SHELLS, completionCandidates, completionScript, filterCompletionCandidates, isCompletionShell, registerCompletion, visibleCommandNames, visibleLongFlags, walkCompletionTree } from "./completion.js";
export { CliError, cliErrorPayload, fail, renderCliError } from "./errors.js";
export { argOrPick, canPickInteractively } from "./pickers.js";
export { attachGlobalFlags, contextFor, emitJson, immutableCliRuntime, processCliRuntime } from "./context.js";
export { collect, parseIdValue, parsePort, parsePositiveInteger, parsePositiveNumber } from "./options.js";
export { findFlagTypos, knownLongFlags, levenshtein, warnPassthroughTypos } from "./flags.js";
export { formatPackageVersion, probeBinaryVersion, readPackageVersion } from "./version.js";
```
