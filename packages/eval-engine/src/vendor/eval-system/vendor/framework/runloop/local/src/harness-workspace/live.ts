import { Crypto, Effect, FileSystem, Layer, Path, Semaphore } from "effect";

import {
  HarnessWorkspaceMaterializer,
  prepareHarnessWorkspace,
} from "./index.ts";

/**
 * The live {@link HarnessWorkspaceMaterializer} adapter: executes real workspace
 * materialization by reading from Crypto/FileSystem/Path and writing to disk.
 * Materializes skill links and caches snapshots under the workspace root.
 *
 * Snapshot materialization is a non-atomic transaction: it copies skills into a
 * shared `gen-N` directory, stages a fixed `current.swap` symlink, renames it
 * onto `current`, and rewrites the materialized-skills manifest. Two concurrent
 * `prepare` calls against the same workspace (e.g. the reload watcher's
 * initial-boot materialization racing the first `/api/invoke`) compute the same
 * generation number and collide on the swap link (`EEXIST: symlink (gen-1)`).
 * Serialize materializations through a single-permit semaphore so each runs as a
 * complete transaction.
 *
 * Crypto / FileSystem / Path stay in the requirement channel (not self-provided),
 * so the composition root supplies the platform and tests can swap in stubs.
 */
export const HarnessWorkspaceMaterializerLive: Layer.Layer<
  HarnessWorkspaceMaterializer,
  never,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> = Layer.effect(HarnessWorkspaceMaterializer)(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const materializeLock = yield* Semaphore.make(1);

    return HarnessWorkspaceMaterializer.of({
      prepare: (input) =>
        materializeLock.withPermits(1)(
          prepareHarnessWorkspace(fs, path, input).pipe(
            Effect.provideService(Crypto.Crypto, crypto)
          )
        ),
    });
  })
);
