import type { Effect } from "effect";

import { Context, Layer, Schema } from "effect";

import type { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import type { RemoteFeatureSource } from "./remote-feature-source.ts";

/**
 * Capability boundary for the SSH backup transport used by
 * `remote-feature-root.ts` when the HTTPS tarball fetch can't reach a source (a
 * private repo with no token, or an environment where outbound HTTPS is blocked
 * but SSH to github.com is not). A caller depends on `GitCapability`, never on
 * `ChildProcessSpawner` directly, so the git dependency is a swappable, probed
 * service rather than a bare subprocess call. The live implementation that
 * probes `git` and clones over SSH lives in the `GitCapabilityLive` adapter
 * (`remote-feature-ssh-fallback-live.ts`).
 */

/** `git` is not on `PATH` (or the probe failed to run it). Not a clone failure. */
class GitUnavailableError extends Schema.TaggedErrorClass<GitUnavailableError>()(
  "GitUnavailableError",
  {
    detail: Schema.String,
  }
) {
  override readonly message = this.detail;
}

interface GitCapabilityShape {
  /** Clone `input.source` into `input.extractDir` over SSH. Fails with
   * {@link GitUnavailableError} when `git` is not on `PATH`; with
   * {@link CliFailureError} for any other clone failure. */
  readonly cloneOverSsh: (input: {
    readonly extractDir: string;
    readonly source: RemoteFeatureSource;
  }) => Effect.Effect<void, CliFailureError | GitUnavailableError>;
}

class GitCapability extends Context.Service<
  GitCapability,
  GitCapabilityShape
>()("routekit-eval/cli/features/GitCapability") {
  /**
   * Test seam: a `GitCapability` whose default `cloneOverSsh` reports the
   * capability as unavailable ({@link GitUnavailableError}) with no
   * `ChildProcessSpawner` in scope at all, for a caller that has no
   * subprocess-spawning capability to offer (or a test that wants the
   * git-missing path without a fake spawner). Override `cloneOverSsh` to
   * exercise a success or a specific failure; the effectful live
   * implementation that probes and clones lives in the `GitCapabilityLive`
   * adapter (`remote-feature-ssh-fallback-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<GitCapabilityShape>
  ): Layer.Layer<GitCapability> =>
    Layer.succeed(GitCapability)(
      GitCapability.of({
        cloneOverSsh: () =>
          new GitUnavailableError({
            detail:
              "No git capability is configured; the SSH backup transport is unavailable.",
          }),
        ...impl,
      })
    );
}

export { GitCapability, GitUnavailableError };
export type { GitCapabilityShape };
