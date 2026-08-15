import type { Effect, FileSystem, Path } from "effect";

import { Context, Layer, Schema } from "effect";

/**
 * The port for managed skill resolution (RFC 0002 skill.md). `fetchLatestVersion`
 * and `fetchBundle` reach the Gateway managed skills API; the live HTTP adapter
 * is {@link ManagedSkillFetcherLive} (managed-skill-fetcher-live.ts), which
 * authenticates with `ROUTEKIT_EVAL_BEARER_TOKEN` or the shared credentials written by
 * `routekit-eval login`. Consumers `yield* ManagedSkillFetcher`; tests inject a fake via
 * {@link ManagedSkillFetcher.layerTest}.
 */

class ManagedSkillFetchError extends Schema.TaggedErrorClass<ManagedSkillFetchError>()(
  "ManagedSkillFetchError",
  {
    detail: Schema.String,
  }
) {
  override readonly message = this.detail;
}

interface ManagedSkillFetcherShape {
  readonly fetchBundle: (
    skillId: string,
    version: number
  ) => Effect.Effect<
    Uint8Array,
    ManagedSkillFetchError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly fetchLatestVersion: (
    skillId: string
  ) => Effect.Effect<
    number,
    ManagedSkillFetchError,
    FileSystem.FileSystem | Path.Path
  >;
}

// The two methods pass `FileSystem | Path` through to the caller rather than
// resolving them at layer build. This is intentional and benign: every consumer
// (`resolveManagedSkill`, `importSkillFile`, the boot path) already requires both
// platform services, so the pass-through adds nothing to their surface. (The
// `HttpClient` transport, by contrast, is now captured at the adapter's layer
// build — see `ManagedSkillFetcherLive` — so it does not appear on the method
// channels.)
// @effect-diagnostics-next-line leakingRequirements:off
export class ManagedSkillFetcher extends Context.Service<
  ManagedSkillFetcher,
  ManagedSkillFetcherShape
>()("routekit-eval/runloop/ManagedSkillFetcher") {
  /**
   * Test seam: inert defaults where both methods fail with a deterministic
   * {@link ManagedSkillFetchError}, with per-method spread override. A native or
   * feature-development skill never actually fetches, so the inert defaults are
   * correct and fail loudly if a fetch is unexpectedly triggered.
   */
  static readonly layerTest = (
    impl: Partial<ManagedSkillFetcherShape>
  ): Layer.Layer<ManagedSkillFetcher> =>
    Layer.succeed(ManagedSkillFetcher)(
      ManagedSkillFetcher.of({
        fetchBundle: () =>
          new ManagedSkillFetchError({
            detail: "ManagedSkillFetcher.layerTest: no fetchBundle configured",
          }),
        fetchLatestVersion: () =>
          new ManagedSkillFetchError({
            detail:
              "ManagedSkillFetcher.layerTest: no fetchLatestVersion configured",
          }),
        ...impl,
      })
    );
}

export type { ManagedSkillFetcherShape };
export { ManagedSkillFetchError };
