import { Effect, Layer } from "effect";

import type { AssertAssignable } from "./vendor/framework/contracts/internal/src/type-boundary.ts";
import type { Logger } from "./vendor/framework/engine/runtime-io/src/logger.ts";

import { HostProcess } from "./vendor/framework/contracts/internal/src/cli/host-process.ts";
import { fetchHttpClientLayer } from "./vendor/framework/contracts/internal/src/http-client.ts";
import {
  builtInSqliteStateStoreLayer,
  BuiltInDbCatalog,
} from "./vendor/framework/runloop/builtins-catalog/src/db.ts";
import { readPersonaEnv } from "./vendor/framework/contracts/internal/src/cli/intern-launcher-env.ts";
import { agentRunnerLayer } from "./vendor/framework/runloop/local/src/agent-runner/index.ts";
import { FeatureCatalog } from "./vendor/framework/runloop/local/src/catalog/feature.ts";
import { FeatureImportPolicy } from "./vendor/framework/runloop/local/src/feature-boot/import-policy.ts";
import { featureRuntimeLayer } from "./vendor/framework/runloop/local/src/feature-runtime/live.ts";
import { HarnessWorkspaceMaterializerLive } from "./vendor/framework/runloop/local/src/harness-workspace/live.ts";
import { globalFeatureLogLayer } from "./vendor/framework/runloop/local/src/logging/support.ts";
import { OpenRouterModelsLive } from "./vendor/framework/runloop/local/src/openrouter/models-live.ts";
import {
  nodeServicesLayer,
  cliIoLayer,
  hostRuntimeLayer,
  loggerLayer,
} from "./vendor/framework/runloop/local/src/runtime/io-layer.ts";
import { ExternalSkillsConfig } from "./vendor/framework/runloop/local/src/skills/external-config.ts";

import {
  BuiltInHarnessCatalog,
  productSelectedAdapterCoordinatorLayer,
} from "./product-harness";
import {
  CREATE_EVAL_SKILL_NAME,
  EVAL_SYSTEM_CODE_FEATURE_ID,
  resolveCreateEvalSkillEntries,
  resolveCreateEvalSuggestion,
} from "./product-code-assets";
import { readTextAsset } from "./runtime/text-asset.ts";

const CODE_PERSONA_FEATURE_ID = "@eval-system/code";
const codePersonaMarkdown = readTextAsset(import.meta.url, "../skills/code-persona.md");

const productPromptsForEnv = (env: NodeJS.ProcessEnv) => {
  if (readPersonaEnv(env) !== "code") return [];
  const fragment = {
    name: "@eval-system/code",
    order: -2000,
    text: codePersonaMarkdown.replace(/\r?\n$/u, ""),
  };
  return [
    {
      entry: {
        name: fragment.name ?? CODE_PERSONA_FEATURE_ID,
        order: fragment.order ?? 0,
        text: fragment.text,
        type: "static" as const,
      },
      featureId: CODE_PERSONA_FEATURE_ID,
      kind: "prompt" as const,
      origin: "builtIn" as const,
      shadows: false,
      sourcePath: `${CODE_PERSONA_FEATURE_ID}/feature.ts`,
    },
  ];
};

/**
 * The eval product's production catalog.
 *
 * It deliberately keeps only the production surfaces the pipeline reaches:
 * Pi, Claude, and Codex author harnesses, the code persona, create-eval,
 * SQLite, feature runtime, and agent runner. Feature-development, unrelated
 * code skills, APIs, chats, and user-global external skills are not part of
 * this product.
 */
const focusedFeatureCatalogLayer = Layer.effect(
  FeatureCatalog,
  Effect.gen(function* () {
    const dbs = yield* BuiltInDbCatalog;
    const harnesses = yield* BuiltInHarnessCatalog;
    const hostProcess = yield* HostProcess;
    const env = yield* hostProcess.env;
    const suggestion = yield* resolveCreateEvalSuggestion();

    return FeatureCatalog.of({
      apis: [],
      chats: [],
      ...dbs,
      ...harnesses,
      authoringSkillName: CREATE_EVAL_SKILL_NAME,
      codeSkillSuggestions: [suggestion],
      disabledSkillNames: [],
      prompts: productPromptsForEnv(env),
      resolveWorkspaceSkills: resolveCreateEvalSkillEntries,
      skills: [],
      warnings: [],
      workspaceFeatureIds: [EVAL_SYSTEM_CODE_FEATURE_ID],
      workspaceSkillNames: [CREATE_EVAL_SKILL_NAME],
    });
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(BuiltInDbCatalog.layer.pipe(Layer.provide(builtInSqliteStateStoreLayer))),
  ),
  Layer.provide(BuiltInHarnessCatalog.layer),
  Layer.provide(productSelectedAdapterCoordinatorLayer),
);

const nodeRuntimeServicesLayer = Layer.mergeAll(nodeServicesLayer, cliIoLayer, hostRuntimeLayer);

const makeExternalSkillsConfigLayer = (
  externalSkillsRoot?: string,
): Layer.Layer<ExternalSkillsConfig> =>
  externalSkillsRoot === undefined
    ? ExternalSkillsConfig.disabled
    : ExternalSkillsConfig.fromRoot(externalSkillsRoot);

const harnessWorkspaceMaterializerLayer = HarnessWorkspaceMaterializerLive.pipe(
  Layer.provide(nodeServicesLayer),
);
const openRouterModelsLayer = OpenRouterModelsLive.pipe(Layer.provide(fetchHttpClientLayer));

export const makeEvalFeatureCatalogLayer = (
  externalSkillsConfigLayer: Layer.Layer<ExternalSkillsConfig>,
): Layer.Layer<
  Layer.Success<typeof focusedFeatureCatalogLayer>,
  Layer.Error<typeof focusedFeatureCatalogLayer>,
  Logger
> => {
  const provided = focusedFeatureCatalogLayer.pipe(
    Layer.provide(externalSkillsConfigLayer),
    Layer.provide(nodeRuntimeServicesLayer),
  );
  type _MustRequireLogger = AssertAssignable<
    Layer.Layer<
      Layer.Success<typeof focusedFeatureCatalogLayer>,
      Layer.Error<typeof focusedFeatureCatalogLayer>,
      Logger
    >,
    typeof provided
  >;
  return provided;
};

export const makeEvalAgentRunnerLayer = (externalSkillsRoot?: string) => {
  const externalSkillsConfigLayer = makeExternalSkillsConfigLayer(externalSkillsRoot);
  const featureCatalog = makeEvalFeatureCatalogLayer(externalSkillsConfigLayer);
  const featureRuntime = featureRuntimeLayer.pipe(
    Layer.provide(Layer.mergeAll(featureCatalog, FeatureImportPolicy.layer)),
    Layer.provideMerge(productSelectedAdapterCoordinatorLayer),
    Layer.provide(nodeRuntimeServicesLayer),
  );
  return agentRunnerLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        featureRuntime,
        harnessWorkspaceMaterializerLayer,
        hostRuntimeLayer,
        openRouterModelsLayer,
      ),
    ),
    Layer.provide(externalSkillsConfigLayer),
    Layer.provideMerge(featureCatalog),
    Layer.provide(nodeRuntimeServicesLayer),
  );
};

const loggerWithGlobalLayer = globalFeatureLogLayer.pipe(Layer.provideMerge(loggerLayer));
const evalCoreLayer = Layer.mergeAll(cliIoLayer, hostRuntimeLayer).pipe(
  Layer.provideMerge(loggerWithGlobalLayer),
  Layer.provideMerge(makeEvalAgentRunnerLayer()),
);

export const providedEvalCliLayer = Layer.mergeAll(nodeServicesLayer, hostRuntimeLayer).pipe(
  Layer.provideMerge(evalCoreLayer),
  Layer.provide(ExternalSkillsConfig.disabled),
  Layer.provide(loggerLayer),
  Layer.provide(nodeRuntimeServicesLayer),
);
