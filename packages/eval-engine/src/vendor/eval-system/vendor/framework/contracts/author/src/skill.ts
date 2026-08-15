/**
 * Frontmatter `metadata` map, mirroring the Agent Skills specification's
 * arbitrary metadata field (https://agentskills.io/specification). RouteKitEval reads
 * its namespaced managed skill pointer keys (RFC 0002 skill.md):
 *
 * - `gateway-skill-id` — the Gateway managed skill's canonical id
 *   (`skill_...`) whose published content backs this skill. When set, the
 *   runtime resolves the skill body and support files from the managed skills
 *   API at the run boundary; the committed body (if any) is only an offline
 *   fallback.
 * - `gateway-skill-slug` — the managed skill's workspace-scoped slug
 *   (`pdf-extract`), resolved through the workspace of the Gateway API key.
 *   An alternative to `gateway-skill-id`; a skill must set at most one of
 *   the two, and a file that sets both is rejected with a diagnostic.
 * - `gateway-skill-version` — optional version pin (a positive integer,
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
   * routekit-eval does not enforce it yet. Unknown frontmatter keys are ignored.
   */
  readonly "allowed-tools"?: string | readonly string[] | undefined;
  /**
   * Human-readable summary of what the skill does. Required for a native
   * skill; optional when a managed skill pointer (`metadata.gateway-skill-id`
   * or `metadata.gateway-skill-slug`) is set, in which case the description
   * resolves from the managed skill's published `SKILL.md` so the committed
   * pointer file cannot drift out of sync.
   */
  readonly description?: string | undefined;
  /**
   * Spec `metadata` map. RouteKitEval reads the managed skill pointer keys from it;
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
