export const EXPERIMENT_BUDGET_CEILING_USD = 200;
export const TASK_CONTEXT_REPRESENTATION = "task_aware_repo_profile";
// Codex adds its tool schema, harness instructions, and repository interaction
// transcript around the explicit oracle prompt. Reserve this overhead per call
// so the hard budget remains conservative even when the judge inspects files.
export const CODEX_HARNESS_INPUT_OVERHEAD_TOKENS_PER_CALL = 175_000;
