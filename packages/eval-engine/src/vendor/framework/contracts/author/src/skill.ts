/**
 * Frontmatter `metadata` map, mirroring the Agent Skills specification's
 * arbitrary metadata field (https://agentskills.io/specification). Ori reads
 * its namespaced managed skill pointer keys (RFC 0002 skill.md):
 *
 * - `openrouter-skill-id` — the OpenRouter managed skill's canonical id
 *   (`skill_...`) whose published content backs this skill. When set, the
 *   runtime resolves the skill body and support files from the managed skills
 *   API at the run boundary; the committed body (if any) is only an offline
 *   fallback.
 * - `openrouter-skill-slug` — the managed skill's workspace-scoped slug
 *   (`pdf-extract`), resolved through the workspace of the OpenRouter API key.
 *   An alternative to `openrouter-skill-id`; a skill must set at most one of
 *   the two, and a file that sets both is rejected with a diagnostic.
 * - `openrouter-skill-version` — optional version pin (a positive integer,
 *   or its string form per the spec's string-valued metadata). When set, the
 *   runtime always materializes exactly this published version and never
 *   refetches it. Omitted means the latest version is resolved at lock time.
 *
 * Other keys are accepted and ignored.
 */
export type SkillMetadata = Readonly<
  Record<string, number | string | readonly string[] | undefined>
>;

export interface SkillFrontmatter {
  /**
   * Tools the skill is allowed to use, mirroring the `allowed-tools` frontmatter
   * field used by other agent skill formats. Accepted and stored for portability;
   * ori does not enforce it yet. Unknown frontmatter keys are ignored.
   */
  readonly "allowed-tools"?: string | readonly string[] | undefined;
  /**
   * Human-readable summary of what the skill does. Required for a native
   * skill; optional when a managed skill pointer (`metadata.openrouter-skill-id`
   * or `metadata.openrouter-skill-slug`) is set, in which case the description
   * resolves from the managed skill's published `SKILL.md` so the committed
   * pointer file cannot drift out of sync.
   */
  readonly description?: string | undefined;
  /**
   * Spec `metadata` map. Ori reads the managed skill pointer keys from it;
   * see {@link SkillMetadata}.
   */
  readonly metadata?: SkillMetadata | undefined;
  /**
   * Skill name. Required for a native skill; optional when a managed skill
   * pointer is set, in which case the name resolves from the managed skill's
   * published `SKILL.md`.
   */
  readonly name?: string | undefined;
}

export interface SkillDocument extends SkillFrontmatter {
  readonly body: string;
}
