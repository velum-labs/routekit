import { Context, Effect, FileSystem, Layer, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { TestdriveEvidenceError } from "./contracts.js";
import { TestdriveProcess } from "./process.js";

export interface TestdriveWorkspaceService {
  readonly checkoutRoot: string;
  readonly profileRepository: string;
  readonly stateHome: string;
  readonly userHome: string;
  readonly xdgConfigHome: string;
  readonly revision: string;
}

export class TestdriveWorkspace extends Context.Service<
  TestdriveWorkspace,
  TestdriveWorkspaceService
>()("@velum-labs/routekit-testkit/TestdriveWorkspace") {}

export const makeTestdriveWorkspaceLayer = (options: {
  readonly repositoryRoot: string;
}): Layer.Layer<
  TestdriveWorkspace,
  TestdriveEvidenceError,
  ChildProcessSpawner | FileSystem.FileSystem | Path.Path | TestdriveProcess
> =>
  Layer.effect(
    TestdriveWorkspace,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const processService = yield* TestdriveProcess;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "routekit-eval-routing-live-" });
      const checkoutRoot = paths.join(root, "checkout");
      yield* processService
        .run("git", ["worktree", "add", "--detach", checkoutRoot, "HEAD"], {
          cwd: options.repositoryRoot,
          timeoutMs: 60_000
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TestdriveEvidenceError({
                detail: "failed to create clean detached testdrive worktree",
                cause
              })
          )
        );
      yield* Effect.addFinalizer(() =>
        processService
          .run("git", ["worktree", "remove", "--force", checkoutRoot], {
            cwd: options.repositoryRoot,
            timeoutMs: 60_000
          })
          .pipe(Effect.ignore)
      );
      const revision = (yield* processService
        .run("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot, timeoutMs: 30_000 })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TestdriveEvidenceError({
                detail: "failed to resolve testdrive revision",
                cause
              })
          )
        )).stdout.trim();
      const stateHome = paths.join(root, "routekit-state");
      const userHome = paths.join(root, "home");
      const xdgConfigHome = paths.join(userHome, ".config");
      yield* fs.makeDirectory(stateHome, { recursive: true, mode: 0o700 });
      yield* fs.makeDirectory(xdgConfigHome, { recursive: true, mode: 0o700 });
      return TestdriveWorkspace.of({
        checkoutRoot,
        profileRepository: checkoutRoot,
        stateHome,
        userHome,
        xdgConfigHome,
        revision
      });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof TestdriveEvidenceError
          ? cause
          : new TestdriveEvidenceError({
              detail: "failed to initialize isolated testdrive workspace",
              cause
            })
      )
    )
  );
