import type { Effect as EffectType, FileSystem } from "effect";

import { Effect } from "effect";

export const isExistingDirectory = (
  fs: FileSystem.FileSystem,
  target: string
): EffectType.Effect<boolean> =>
  fs.stat(target).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false)
  );
