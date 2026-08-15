import { Context } from "effect";

import type {
  ModelRegistryEntry,
  ModelValue,
} from "../../../contracts/internal/src/author-schemas/model.ts";

import { BuiltinName } from "../../../contracts/internal/src/builtin-name.ts";

const noModel: ModelValue | undefined = undefined;

export interface ModelRegistryShape {
  readonly entries: readonly ModelRegistryEntry[];
  // The default model is a static slug (or `null`) declared in the root `ori.md`
  // frontmatter — there is no per-invocation resolution, so this is a plain lookup
  // of the single entry named `BuiltinName.Model` (RFC 0002 root-persona.md).
  readonly resolve: () => ModelValue | undefined;
}

export class ModelRegistry extends Context.Service<
  ModelRegistry,
  ModelRegistryShape
>()("ori/runtime/ModelRegistry") {}

export const makeModelRegistry = (
  entries: readonly ModelRegistryEntry[]
): ModelRegistryShape =>
  ModelRegistry.of({
    entries,
    // Preserve the distinction between "no entry" (→ undefined, omit the model flag)
    // and "an entry whose model is `null`" (→ null, intentionally omit) — so this is a
    // presence check, not a `?? noModel` collapse that would map `null` to `undefined`.
    resolve: () => {
      const selected = entries.find(
        (entry) => entry.name === BuiltinName.Model
      );
      return selected === undefined ? noModel : selected.model;
    },
  });
