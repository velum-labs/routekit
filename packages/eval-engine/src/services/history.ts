import { Context, Effect, FileSystem, Layer, Path } from "effect";

import type { EvalHistoryEntry } from "../history/index.js";
import { pruneEvalHistory, readEvalHistory, renderLines } from "../history/index.js";

export interface EvalHistoryService {
  readonly read: (path: string) => Effect.Effect<readonly EvalHistoryEntry[]>;
  readonly append: (path: string, entry: EvalHistoryEntry) => Effect.Effect<void>;
}
export class EvalHistory extends Context.Service<EvalHistory, EvalHistoryService>()(
  "@velum-labs/routekit-eval-engine/EvalHistory"
) {}
export const EvalHistoryLive = Layer.effect(
  EvalHistory,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return EvalHistory.of({
      read: (path) =>
        readEvalHistory(path).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.orElseSucceed(() => [])
        ),
      append: (path, entry) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(path, renderLines([entry]), { flag: "a" });
          yield* pruneEvalHistory(path).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, paths),
            Effect.ignore
          );
        }).pipe(Effect.orElseSucceed(() => undefined))
    });
  })
);
