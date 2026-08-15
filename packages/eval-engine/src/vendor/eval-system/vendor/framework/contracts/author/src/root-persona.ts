import type { ModelSlug } from "./model.ts";

export interface RootPersonaFrontmatter {
  /**
   * Additional feature sources to compose with the workspace's own `features/`
   * at boot. Each entry is a local directory or a remote repo path
   * (`github.com/<owner>/<repo>[/path][@ref]`), resolved the same way a
   * `--features` value is. The workspace's own `features/` shadows a declared
   * same-named feature, and `--features` CLI flags shadow everything. Omitted
   * when the workspace boots only its own `features/`.
   */
  readonly features?: readonly string[] | undefined;
  /**
   * Preferred harness for the workspace (e.g. `pi`, `claude`). Names the head of
   * the optimistic harness-selection priority order: the runtime loads this
   * harness when its binary is present, otherwise it falls back through the
   * remaining built-in harnesses in priority order (RFC 0006). When omitted the
   * priority order starts at the built-in default (`pi`).
   */
  readonly harness?: string | undefined;
  /** Default model slug for the workspace (e.g. `gateway/auto`). */
  readonly model?: ModelSlug | undefined;
  /** Optional name for the contributed base prompt fragment. */
  readonly name?: string | undefined;
  /** Optional ordering for the contributed base prompt fragment. */
  readonly order?: number | string | undefined;
  /** Optional section header for the contributed base prompt fragment. */
  readonly section?: string | undefined;
  /**
   * The RouteKitEval CLI version that scaffolded this workspace, stamped by `routekit-eval init`
   * (e.g. `0.4.2`). Provenance metadata only — a soft record of which CLI
   * generated the project's SDK, never a pin: the runtime does not read it to
   * gate behavior. Tooling (e.g. an `routekit-eval upgrade` diagnostic) can compare it
   * against the running CLI to surface "generated with X, now on Y". Omitted
   * when a workspace is hand-authored or scaffolded by a CLI build that exposes
   * no resolvable version.
   */
  readonly version?: string | undefined;
}
