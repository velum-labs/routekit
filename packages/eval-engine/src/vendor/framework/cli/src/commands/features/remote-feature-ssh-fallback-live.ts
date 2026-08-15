import type { Duration } from "effect";

import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { RemoteFeatureSource } from "./remote-feature-source.ts";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import {
  GitCapability,
  GitUnavailableError,
} from "./remote-feature-ssh-fallback.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

/**
 * Live {@link GitCapability} adapter: probes `git` once at layer construction
 * and clones over SSH. Kept in a sibling `*-live.ts` module so the port
 * (`remote-feature-ssh-fallback.ts`) carries only the tag, shape, and error,
 * and the import direction stays one-way (adapter imports port). The retry
 * helper lives here too because it provides this layer internally, so it
 * cannot sit in the port without a cycle.
 */

const PROCESS_SUCCESS_EXIT_CODE = 0;

// Bounds how long a doomed SSH attempt (no key, no agent, blocked egress) can
// delay resolution before the caller sees the original HTTPS error. `init`,
// `remote add`, and `checkout` are local and finish in milliseconds, so this
// budget only needs to cover a slow or hung connection attempt.
const SSH_LOCAL_STEP_TIMEOUT = "15 seconds";

// `fetch` is the one step that transfers the repo over the network; its
// budget is the effective cap on how large a repo (at --depth=1) the SSH
// backup can recover within one run. Kept separate from the local-step
// timeout so a large repo over a slow link doesn't fail the backup outright
// while SSH connectivity itself is fine.
const SSH_FETCH_TIMEOUT = "60 seconds";

// Non-interactive and fails fast: BatchMode=yes rules out a passphrase or host
// key prompt hanging forever, and ConnectTimeout bounds a silently-dropped
// connection attempt (a rejected one usually errors sooner).
const GIT_SSH_COMMAND =
  "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new";

const GIT_VERSION_PROBE_TIMEOUT = "5 seconds";

/**
 * Run one `git` step of the SSH clone and capture its stderr instead of
 * inheriting it: a failed SSH backup (no key, no agent — the common case when
 * HTTPS is failing for unrelated reasons) must not spam the terminal with
 * git's own error text, since the caller discards this failure and re-raises
 * the original HTTPS error instead. Every step shares `GIT_SSH_COMMAND`, but
 * `timeout` varies by step: local steps use the short budget, `fetch` (the
 * only one that transfers data over the network) uses the longer one.
 */
const runGitStep = Effect.fn("RemoteFeatures.runGitStep")(function* (
  spawner: Spawner,
  input: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeout: Duration.Input;
  }
) {
  const [exitCode, stderr] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", [...input.args], {
          cwd: input.cwd,
          env: { GIT_SSH_COMMAND },
          extendEnv: true,
          stderr: "pipe",
          stdin: "ignore",
          stdout: "ignore",
        })
      );
      return yield* Effect.all(
        [
          handle.exitCode,
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: "unbounded" }
      );
    })
  ).pipe(
    Effect.timeout(input.timeout),
    Effect.mapError(
      (cause) =>
        new CliFailureError({
          detail: `Could not run git ${input.args[0]}: ${formatUnknownError(cause)}.`,
        })
    )
  );
  if (Number(exitCode) !== PROCESS_SUCCESS_EXIT_CODE) {
    return yield* new CliFailureError({
      detail: `git ${input.args[0]} over SSH exited with code ${exitCode}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}.`,
    });
  }
});

/**
 * Clone `source` into `extractDir` (already created and empty, the same
 * directory the HTTPS path would have unpacked the tarball into) over SSH,
 * then drop the resulting `.git` so the cache entry looks the same regardless
 * of which transport produced it.
 *
 * Uses `init` + `fetch` + `checkout FETCH_HEAD` rather than `clone --branch
 * <ref>`: `--branch` only accepts a branch or tag name, so a source pinned to
 * a commit SHA (a ref the HTTPS/codeload path already supports) would
 * otherwise never resolve over the SSH backup. `git fetch` accepts a SHA
 * directly, since GitHub allows fetching any commit reachable from a branch.
 */
const cloneOverSshWith = Effect.fn("RemoteFeatures.cloneOverSsh")(function* (
  services: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly spawner: Spawner;
  },
  input: {
    readonly extractDir: string;
    readonly source: RemoteFeatureSource;
  }
) {
  const { fs, path, spawner } = services;
  const { extractDir } = input;
  const { owner, ref, repo } = input.source;
  const remoteUrl = `git@github.com:${owner}/${repo}.git`;
  const localStep = (
    args: readonly string[]
  ): Effect.Effect<void, CliFailureError> =>
    runGitStep(spawner, {
      args,
      cwd: extractDir,
      timeout: SSH_LOCAL_STEP_TIMEOUT,
    });

  yield* localStep(["init", "--quiet"]);
  yield* localStep(["remote", "add", "origin", remoteUrl]);
  // `--` terminates option parsing before `ref`: the source's ref grammar
  // (`remote-feature-root.ts`'s `REMOTE_SOURCE_PATTERN`) allows a leading
  // `-`, so without it a crafted ref could be read as a git flag instead of
  // a refspec.
  yield* runGitStep(spawner, {
    args: ["fetch", "--depth=1", "--quiet", "origin", "--", ref],
    cwd: extractDir,
    timeout: SSH_FETCH_TIMEOUT,
  });
  yield* localStep(["checkout", "--quiet", "FETCH_HEAD"]);
  yield* fs
    .remove(path.join(extractDir, ".git"), {
      force: true,
      recursive: true,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new CliFailureError({
            detail: `Could not remove the SSH clone's .git directory: ${formatUnknownError(cause)}.`,
          })
      )
    );
});

/**
 * Probe `git --version` once (spawn and check the exit code) so a missing
 * binary is detected at layer construction instead of mid-clone.
 */
const probeGit = Effect.fn("RemoteFeatures.probeGit")(function* (
  spawner: Spawner
) {
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make("git", ["--version"], {
        stderr: "ignore",
        stdout: "ignore",
      })
    )
    .pipe(
      Effect.timeout(GIT_VERSION_PROBE_TIMEOUT),
      Effect.orElseSucceed(() => Number.NaN)
    );
  return Number(exitCode) === PROCESS_SUCCESS_EXIT_CODE;
});

/**
 * The live {@link GitCapability} adapter: probes `git` once against the real
 * `ChildProcessSpawner` and reports unavailability as a typed error. The
 * spawner, `FileSystem`, and `Path` are acquired once in `make` so the shape's
 * `cloneOverSsh` closes over them and they do not leak into its own
 * requirement channel; the layer keeps `ChildProcessSpawner | FileSystem |
 * Path` in its requirement channel rather than self-providing them.
 */
const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const available = yield* probeGit(spawner);
  if (!available) {
    return GitCapability.of({
      cloneOverSsh: () =>
        new GitUnavailableError({
          detail:
            "git is not on PATH; the SSH backup transport is unavailable.",
        }),
    });
  }
  return GitCapability.of({
    cloneOverSsh: (input) =>
      cloneOverSshWith(
        {
          fs,
          path,
          spawner,
        },
        input
      ),
  });
});

export const GitCapabilityLive: Layer.Layer<
  GitCapability,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.effect(GitCapability)(make);

/**
 * Retry step for a failed HTTPS tarball fetch: clear whatever the failed
 * attempt left behind in `extractDir` and clone the same ref over SSH instead
 * via {@link GitCapability}. Callers `.pipe(Effect.catch(...))` this onto the
 * HTTPS attempt directly (see `refreshCache` in `remote-feature-root.ts`) so
 * the retry reads as ordinary Effect control flow rather than a callback
 * threaded through a generic wrapper.
 *
 * `GitCapability` is discharged locally against whichever `ChildProcessSpawner`
 * is already in scope, so this function's public requirement stays
 * `ChildProcessSpawner | FileSystem | Path`, exactly as before the capability
 * existed. `remote-feature-root.ts` already requires
 * `ChildProcessSpawner` for the HTTPS path's own `tar` extraction, so this
 * adds no new requirement for any caller; it only makes the git dependency a
 * swappable, probed capability instead of a bare spawn call. A caller that
 * wants to force the backup off entirely (or test the git-missing path
 * without a fake spawner) can provide {@link GitCapability.layerTest}
 * further downstream before this function runs.
 */
const retryFetchOverSsh = Effect.fn("RemoteFeatures.retryFetchOverSsh")(
  function* (input: {
    readonly extractDir: string;
    readonly source: RemoteFeatureSource;
  }) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(input.extractDir, {
      force: true,
      recursive: true,
    });
    yield* fs.makeDirectory(input.extractDir, { recursive: true });
    yield* Effect.gen(function* () {
      const git = yield* GitCapability;
      yield* git.cloneOverSsh(input);
    }).pipe(Effect.provide(GitCapabilityLive));
  }
);

export { retryFetchOverSsh };
