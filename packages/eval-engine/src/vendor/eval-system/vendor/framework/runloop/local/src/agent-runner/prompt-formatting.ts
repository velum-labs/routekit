const formatFeatureDevelopmentRules = (
  featuresRoot: string,
  authoringSkillName: string
): string =>
  [
    "## ROUTEKIT_EVAL Feature Development Rules",
    "",
    `Active feature root: ${featuresRoot}`,
    "",
    "When creating or updating RouteKitEval features, skills, prompts, harnesses, routes, or other feature contributions:",
    "",
    "1. Write them only under the active feature root.",
    "2. Use root skills at `<active-feature-root>/<feature-id>/SKILL.md`.",
    "3. Use nested skills at `<active-feature-root>/<feature-id>/skills/<skill-name>/SKILL.md` when a feature owns several related skills.",
    "4. Do not create project skills in `.agents/skills`, `.codex/skills`, a repository-level `skills/` directory, or anywhere outside the active feature root unless the user explicitly asks.",
    "5. If the owning feature is unclear, ask before creating files.",
    `6. For contribution shapes and authoring details, use the \`${authoringSkillName}\` skill.`,
    "7. `.agents/skills` and `.claude/skills` are generated snapshot views of the active feature root; never edit them. Edits under the active feature root take effect on your next run, not mid-run.",
  ].join("\n");

// Injected into the `routekit-eval code` system prompt so the agent reports its actual
// runtime instead of guessing its identity (ROUTEKIT_EVAL-397): routed models routinely
// misname themselves when asked conversationally.
export const formatActiveRuntime = (input: {
  readonly harnessName: string;
  readonly model: string | null | undefined;
}): string =>
  [
    "## Active Runtime",
    "",
    `- Harness: ${input.harnessName}`,
    `- Model: ${input.model ?? "the harness's default model"}`,
    "",
    "When asked which model or harness you are running on, answer from this metadata.",
  ].join("\n");

export const assembleSystemPrompt = (input: {
  readonly base?: string | undefined;
  readonly featuresRoot: string;
  readonly includeFeatureDevelopmentRules: boolean;
  readonly authoringSkillName: string;
  readonly activeRuntime?: string | undefined;
}): string | undefined => {
  const sections = [
    input.includeFeatureDevelopmentRules
      ? formatFeatureDevelopmentRules(
          input.featuresRoot,
          input.authoringSkillName
        )
      : undefined,
    input.base,
    input.activeRuntime,
  ].filter((section): section is string => section !== undefined);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
};
