import type { Effect } from "effect";

import { Context } from "effect";

import type { SkillRegistryEntry } from "../../../contracts/internal/src/author-schemas/skill.ts";
import type { RegistryError } from "../../../contracts/internal/src/errors.ts";

import { makeRegistryLookup } from "./registry.ts";

const SKILL_REGISTRY_KIND = "skill";

export type { SkillRegistryEntry };

export interface SkillRegistryShape {
  readonly entries: readonly SkillRegistryEntry[];
  readonly get: (
    name: string
  ) => Effect.Effect<SkillRegistryEntry, RegistryError>;
}

export class SkillRegistry extends Context.Service<
  SkillRegistry,
  SkillRegistryShape
>()("routekit-eval/runtime/SkillRegistry") {}

export const makeSkillRegistry = (
  entries: readonly SkillRegistryEntry[]
): SkillRegistryShape => {
  const registry = makeRegistryLookup<SkillRegistryEntry>({
    entries: entries.map((entry) => ({
      name: entry.name,
      value: entry,
    })),
    kind: SKILL_REGISTRY_KIND,
  });

  return SkillRegistry.of({
    entries,
    get: registry.get,
  });
};
