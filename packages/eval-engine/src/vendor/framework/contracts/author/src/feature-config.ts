/**
 * The scope a {@link FeatureConfig} write targets: the global
 * `~/.ori/config.json` or the workspace-local `<workspace>/.ori/config.json`.
 */
export type FeatureConfigScope = "global" | "local";

/**
 * Feature access to the shared, user-editable `config.json` (RFC 0005
 * feature-config-access.md). The host owns the file mechanics — the two scopes,
 * the local-over-global per-field merge, resilience, and the merge-preserving
 * write; the feature owns its block's schema, defaults, and environment overlay.
 *
 * Resolution is client-local: `read`/`write` act on the `config.json` files on
 * the machine the surface runs on, never a daemon, so a block follows the
 * terminal the user is attached to and reflects a hand-edited file immediately.
 * This is distinct from the state store ({@link StoreResolver}), which is
 * opaque, durable, daemon-owned state.
 */
export interface FeatureConfig {
  /**
   * Read a named block merged local-over-global (per field) from the
   * client-local `config.json` files, or `undefined` when neither scope carries
   * it. Returns the raw decoded JSON for the namespace; the caller decodes it
   * with its own schema and overlays its own environment variables and defaults.
   * Resilient: a missing, unreadable, or malformed file resolves the block as
   * absent rather than failing.
   */
  readonly read: (namespace: string) => Promise<unknown>;
  /**
   * Merge-preserving write of a named block to the chosen scope's `config.json`
   * (default `"global"`). Preserves sibling blocks and any other keys already in
   * the file.
   */
  readonly write: (
    namespace: string,
    value: unknown,
    scope?: FeatureConfigScope
  ) => Promise<void>;
}
