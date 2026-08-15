import { Effect } from "effect";

import type { StateStoreContribution } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { ResolvedFeature } from "../../../../engine/features/src/feature-loader-types.ts";
import type {
  ImportedFeatureContributions,
  ImportedModelContributions,
  ImportedNamedContributions,
} from "./contributions.ts";

import { importApiContributionsFromFeatures } from "../contributions/api.ts";
import { importChatContributionsFromFeatures } from "../contributions/capability-collection.ts";
import { importCommandContributionsFromFeatures } from "../contributions/command.ts";
import { importHarnessContributionsFromFeatures } from "../contributions/harness.ts";
import { importHooksContributionsFromFeatures } from "../contributions/hooks.ts";
import { importPromptContributionsFromFeatures } from "../contributions/prompt.ts";
import { importScheduleContributionsFromFeatures } from "../contributions/schedule.ts";
import { importSkillContributionsFromFeatures } from "../contributions/skill.ts";

const emptyImportedNamedContributions =
  (): ImportedNamedContributions<StateStoreContribution> => ({
    diagnostics: [],
    entries: [],
    records: [],
  });

const importCapabilityFeatureContributions = Effect.fn(
  "FeatureBoot.importCapabilityContributions"
)(function* (
  featuresRoot: string,
  orderedFeatures: readonly ResolvedFeature[]
) {
  const chats = yield* importChatContributionsFromFeatures(
    featuresRoot,
    orderedFeatures
  );
  const commands = yield* importCommandContributionsFromFeatures(
    featuresRoot,
    orderedFeatures
  );
  const schedules = yield* importScheduleContributionsFromFeatures(
    featuresRoot,
    orderedFeatures
  );

  return {
    chats,
    commands,
    dbs: emptyImportedNamedContributions(),
    schedules,
  };
});

// The default model comes only from the root `ori.md` frontmatter (RFC 0002
// root-persona.md); a feature's `SKILL.md` never contributes a model entry.
const emptyModelContributions = (): ImportedModelContributions => ({
  diagnostics: [],
  entries: [],
  records: [],
});

const importCoreFeatureContributions = Effect.fn(
  "FeatureBoot.importCoreContributions"
)(function* (
  featuresRoot: string,
  orderedFeatures: readonly ResolvedFeature[]
) {
  const harnesses = yield* importHarnessContributionsFromFeatures(
    featuresRoot,
    orderedFeatures
  );
  const apis = yield* importApiContributionsFromFeatures(
    featuresRoot,
    orderedFeatures
  );
  const hooks = yield* importHooksContributionsFromFeatures(
    featuresRoot,
    orderedFeatures
  );
  const prompts = yield* importPromptContributionsFromFeatures(
    featuresRoot,
    orderedFeatures
  );
  const skills = yield* importSkillContributionsFromFeatures(
    featuresRoot,
    orderedFeatures
  );
  const modelProviders = emptyModelContributions();

  return {
    apis,
    hooks,
    harnesses,
    modelProviders,
    prompts,
    skills,
  };
});

export const importFeatureContributions = Effect.fn(
  "FeatureBoot.importContributions"
)(function* (
  featuresRoot: string,
  orderedFeatures: readonly ResolvedFeature[]
) {
  const core = yield* importCoreFeatureContributions(
    featuresRoot,
    orderedFeatures
  );
  const capabilities = yield* importCapabilityFeatureContributions(
    featuresRoot,
    orderedFeatures
  );

  return {
    ...core,
    ...capabilities,
  } satisfies ImportedFeatureContributions;
});
