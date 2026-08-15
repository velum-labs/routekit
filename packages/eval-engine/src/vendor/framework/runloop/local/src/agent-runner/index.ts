import type { Option } from "effect";

import { Effect, Layer, Option as EffectOption, Stream } from "effect";

import type {
  AgentRuntimeEvent,
  FeatureLogger,
  StateStore,
  StoreResolver,
} from "../../../../contracts/author/src/index.ts";
import type { RuntimeHarnessCompaction } from "../../../../engine/harness/src/runtime-harness.ts";
import type {
  AgentRunnerShape,
  AgentRunnerCommand,
} from "./service.ts";
import type { FeatureRuntimeBootResult } from "../agent/invocation-defaults.ts";
import type { FeatureRuntimeShape } from "../feature-runtime/service.ts";
import type { HarnessWorkspaceMaterializerShape } from "../harness-workspace/index.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import {
  isPackedInternEnv,
  readPersonaEnv,
} from "../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import { TelemetryObserver } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import { telemetrySurfaceInput } from "../../../../contracts/internal/src/runtime/telemetry-surface.ts";
import { makeHarnessCompactionOptions } from "./compaction-preparation.ts";
import { logDiagnosticEvent } from "./diagnostics.ts";
import { makeHarnessInvokeOptions } from "./invocation-options.ts";
import {
  assembleSystemPrompt,
  formatActiveRuntime,
} from "./prompt-formatting.ts";
import { AgentRunner } from "./service.ts";
import { prepareHarnessWorkspace } from "./skills.ts";
import { observeAgentRun } from "./telemetry.ts";
import { mapTurnUsageCost } from "./usage-pricing.ts";
import {
  resolveModel,
  resolveParameters,
} from "../agent/invocation-defaults.ts";
import {
  fallbackAuthorStateStore,
  makeAuthorStoreResolver,
} from "../author/store-resolver.ts";
import { FeatureCatalog } from "../catalog/feature.ts";
import { FeatureRuntime } from "../feature-runtime/service.ts";
import { HarnessWorkspaceMaterializer } from "../harness-workspace/index.ts";
import { featureLoggerFromContext } from "../logging/support.ts";
import {
  ContextWindowLookup,
  makeContextWindowLookup,
} from "../models/context-window.ts";
import { OpenRouterModels } from "../openrouter/models-service.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

type HarnessName = NonNullable<AgentRunnerCommand["harnessName"]>;
interface PromptAssemblyContext {
  readonly boot: FeatureRuntimeBootResult;
  readonly command: AgentRunnerCommand;
  readonly stores: StoreResolver;
  readonly logger: FeatureLogger;
  readonly catalog: FeatureCatalog["Service"];
}
const assemblePrompt = Effect.fn("AgentRunner.assemblePrompt")(function* (
  context: PromptAssemblyContext
) {
  const { boot, command, stores, logger } = context;
  return yield* boot.promptRegistry
    .assemble({
      logger,
      prompt: command.prompt,
      sessionId: command.sessionId,
      state: stores.state,
      stores,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeServerError({
            cause,
            detail: cause.message,
            operation: "assembling feature prompt",
          })
      )
    );
});
const resolveStateStore = (
  boot: FeatureRuntimeBootResult
): Effect.Effect<StateStore> =>
  boot.dbRegistry.default.pipe(
    Effect.orElseSucceed(() => fallbackAuthorStateStore)
  );
const resolveHarness = Effect.fn("AgentRunner.resolveHarness")(function* (
  harnessRegistry: FeatureRuntimeBootResult["harnessRegistry"],
  harnessName: HarnessName | undefined
) {
  if (harnessName) {
    return yield* harnessRegistry.get(harnessName);
  }
  return yield* harnessRegistry.default;
});
const resolveSystemPrompt = Effect.fn("AgentRunner.resolveSystemPrompt")(
  function* (context: PromptAssemblyContext) {
    if (context.command.systemPrompt !== undefined) {
      return context.command.systemPrompt;
    }
    return yield* assemblePrompt(context);
  }
);
interface HarnessRuntimeDeps {
  readonly featureRuntime: FeatureRuntimeShape;
  readonly hostProcess: HostProcess["Service"];
  readonly harnessWorkspaceMaterializer: HarnessWorkspaceMaterializerShape;
  readonly telemetryObserver: Option.Option<TelemetryObserver["Service"]>;
  readonly catalog: FeatureCatalog["Service"];
}
const resolveAssembledSystemPrompt = Effect.fn(
  "AgentRunner.resolveAssembledSystemPrompt"
)(function* (
  promptContext: PromptAssemblyContext,
  hostProcess: HostProcess["Service"],
  activeRuntime: {
    readonly harnessName: string;
    readonly model: string | null | undefined;
  }
) {
  const baseSystemPrompt = yield* resolveSystemPrompt(promptContext);
  const env = yield* hostProcess.env;
  const persona = readPersonaEnv(env);
  return assembleSystemPrompt({
    // The Active Runtime section rides the same gate as the code persona
    // itself (built-in-catalog/prompt.ts): only `ori code` gets it, so a
    // project's own composed prompt is never appended to.
    activeRuntime:
      persona === "code" ? formatActiveRuntime(activeRuntime) : undefined,
    base: baseSystemPrompt,
    featuresRoot: promptContext.command.featuresRoot,
    // Keep this gate in sync with `disabledBuiltInSkillNamesForEnv`: both packed
    // interns and `ori code` have the feature-development skill disabled, so the
    // prompt rules (which reference that skill by name) must be omitted too — else
    // the agent gets authoring instructions for a skill it cannot access.
    includeFeatureDevelopmentRules:
      !isPackedInternEnv(env) && persona !== "code",
    authoringSkillName: promptContext.catalog.authoringSkillName,
  });
});
const mirrorDiagnosticEvents = <A extends AgentRuntimeEvent, E, R>(
  events: Stream.Stream<A, E, R>,
  diagnosticsLogger: FeatureLogger
): Stream.Stream<A, E, R> =>
  Stream.tap(events, (event) =>
    Effect.sync(() => {
      logDiagnosticEvent(diagnosticsLogger, event);
    })
  );
const prepareHarnessInvocation = Effect.fn(
  "AgentRunner.prepareHarnessInvocation"
)(function* (input: {
  readonly assembledSystemPrompt: string | undefined;
  readonly boot: FeatureRuntimeBootResult;
  readonly command: AgentRunnerCommand;
  readonly context: Parameters<typeof featureLoggerFromContext>[0];
  readonly deps: HarnessRuntimeDeps;
  readonly harness: Effect.Success<ReturnType<typeof resolveHarness>>;
  readonly model: string | null | undefined;
}) {
  const diagnosticsLogger = featureLoggerFromContext(
    input.context,
    "runloop.agent-runner"
  );
  const { contextWindow, env, extraSkillDirs, workspace } =
    yield* prepareHarnessWorkspace({
      bootSkills: input.boot.skillEntries,
      command: input.command,
      defaultModel: input.harness.defaultModel,
      diagnosticsLogger,
      catalog: input.deps.catalog,
      hostProcess: input.deps.hostProcess,
      materializer: input.deps.harnessWorkspaceMaterializer,
      model: input.model,
      workspaceFeatureIds: input.deps.catalog.workspaceFeatureIds,
    });
  const persona = readPersonaEnv(env);
  const mergedEnv = {
    ...env,
    ...input.command.env,
  };
  const events = input.harness.invoke(
    makeHarnessInvokeOptions({
      assembledSystemPrompt: input.assembledSystemPrompt,
      command: input.command,
      contextWindow,
      cwd: workspace.cwd,
      disableBundledSkills: persona === "code",
      env: mergedEnv,
      extraSkillDirs,
      parameters: yield* resolveParameters(input.command, input.model),
      model: input.model,
    })
  );
  return {
    diagnosticsLogger,
    events,
  };
});
const prepareHarnessCompaction = Effect.fn(
  "AgentRunner.prepareHarnessCompaction"
)(function* (input: {
  readonly assembledSystemPrompt: string | undefined;
  readonly boot: FeatureRuntimeBootResult;
  readonly command: AgentRunnerCommand;
  readonly context: Parameters<typeof featureLoggerFromContext>[0];
  readonly deps: HarnessRuntimeDeps;
  readonly harness: Effect.Success<ReturnType<typeof resolveHarness>>;
  readonly compact: Option.Option<RuntimeHarnessCompaction>;
  readonly model: string | null | undefined;
}) {
  const diagnosticsLogger = featureLoggerFromContext(
    input.context,
    "runloop.agent-runner"
  );
  if (EffectOption.isNone(input.compact)) {
    return EffectOption.none();
  }
  const { contextWindow, env, extraSkillDirs, workspace } =
    yield* prepareHarnessWorkspace({
      bootSkills: input.boot.skillEntries,
      command: input.command,
      defaultModel: input.harness.defaultModel,
      diagnosticsLogger,
      catalog: input.deps.catalog,
      hostProcess: input.deps.hostProcess,
      materializer: input.deps.harnessWorkspaceMaterializer,
      model: input.model,
      workspaceFeatureIds: input.deps.catalog.workspaceFeatureIds,
    });
  const persona = readPersonaEnv(env);
  const options = makeHarnessCompactionOptions({
    assembledSystemPrompt: input.assembledSystemPrompt,
    command: input.command,
    contextWindow,
    cwd: workspace.cwd,
    disableBundledSkills: persona === "code",
    env: {
      ...env,
      ...input.command.env,
    },
    extraSkillDirs,
    model: input.model,
    parameters: yield* resolveParameters(input.command, input.model),
  });
  return EffectOption.some(
    mirrorDiagnosticEvents(input.compact.value(options), diagnosticsLogger)
  );
});
const resolveAgentHarness = (
  boot: FeatureRuntimeBootResult,
  command: AgentRunnerCommand
): ReturnType<typeof resolveHarness> =>
  resolveHarness(boot.harnessRegistry, command.harnessName);
const recoverCompactionPreparation = Effect.fn(
  "AgentRunner.recoverCompactionPreparation"
)((cause: unknown) =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    featureLoggerFromContext(context, "runloop.agent-runner")
      .child("harness")
      .warn("could not prepare harness compaction", {
        detail: formatUnknownError(cause),
      });
  })
);
const invokeHarnessRuntime = Effect.fn("AgentRunner.invokeHarnessRuntime")(
  function* (deps: HarnessRuntimeDeps, command: AgentRunnerCommand) {
    const boot = yield* deps.featureRuntime.boot(command.featuresRoot);
    const context = yield* Effect.context();
    const stores = makeAuthorStoreResolver(
      context,
      boot,
      yield* resolveStateStore(boot)
    );
    const logger = featureLoggerFromContext(context, "feature");
    const harness = yield* resolveAgentHarness(boot, command);
    const model = resolveModel(boot, command);
    const assembledSystemPrompt = yield* resolveAssembledSystemPrompt(
      {
        boot,
        command,
        logger,
        catalog: deps.catalog,
        stores,
      },
      deps.hostProcess,
      {
        harnessName: harness.name,
        model,
      }
    );
    const { diagnosticsLogger, events } = yield* prepareHarnessInvocation({
      assembledSystemPrompt,
      boot,
      command,
      context,
      deps,
      harness,
      model,
    });
    return observeAgentRun({
      cancelState: command.cancelState,
      cancelSignal: command.cancelSignal,
      observer: deps.telemetryObserver,
      telemetryId: harness.telemetryId,
      surface: telemetrySurfaceInput(command.telemetrySurface),
      events: mirrorDiagnosticEvents(
        mapTurnUsageCost(events),
        diagnosticsLogger
      ),
    });
  }
);
const makeCompactionInvoker =
  (input: {
    readonly contextWindowLookup: ContextWindowLookup["Service"];
    readonly deps: HarnessRuntimeDeps;
    readonly openRouterModels: OpenRouterModels["Service"];
  }): AgentRunnerShape["invokeCompaction"] =>
  (command) => {
    const compaction = Effect.gen(function* () {
      const boot = yield* input.deps.featureRuntime.boot(command.featuresRoot);
      const context = yield* Effect.context();
      const stores = makeAuthorStoreResolver(
        context,
        boot,
        yield* resolveStateStore(boot)
      );
      const logger = featureLoggerFromContext(context, "feature");
      const harness = yield* resolveAgentHarness(boot, command);
      const compact = yield* harness.compact;
      if (EffectOption.isNone(compact)) {
        return EffectOption.none();
      }
      const model = resolveModel(boot, command);
      const assembledSystemPrompt = yield* resolveAssembledSystemPrompt(
        {
          boot,
          command,
          logger,
          catalog: input.deps.catalog,
          stores,
        },
        input.deps.hostProcess,
        {
          harnessName: harness.name,
          model,
        }
      );
      const events = yield* prepareHarnessCompaction({
        assembledSystemPrompt,
        boot,
        command,
        context,
        deps: input.deps,
        harness,
        compact,
        model,
      });
      return events.pipe(
        EffectOption.map((stream) =>
          observeAgentRun({
            cancelState: command.cancelState,
            cancelSignal: command.cancelSignal,
            observer: input.deps.telemetryObserver,
            telemetryId: harness.telemetryId,
            surface: telemetrySurfaceInput(command.telemetrySurface),
            events: mapTurnUsageCost(stream),
          })
        )
      );
    });
    return compaction.pipe(
      Effect.provideService(OpenRouterModels, input.openRouterModels),
      Effect.provideService(ContextWindowLookup, input.contextWindowLookup),
      Effect.tapError(recoverCompactionPreparation),
      Effect.orElseSucceed(() => EffectOption.none())
    );
  };
export const agentRunnerLayer = Layer.effect(AgentRunner)(
  Effect.gen(function* () {
    const deps: HarnessRuntimeDeps = {
      featureRuntime: yield* FeatureRuntime,
      harnessWorkspaceMaterializer: yield* HarnessWorkspaceMaterializer,
      hostProcess: yield* HostProcess,
      telemetryObserver: yield* Effect.serviceOption(TelemetryObserver),
      catalog: yield* FeatureCatalog,
    };
    const openRouterModels = yield* OpenRouterModels;
    const contextWindowLookup = ContextWindowLookup.of(
      makeContextWindowLookup()
    );
    const invokeRuntime: AgentRunnerShape["invokeRuntime"] = (command) =>
      Stream.unwrap(invokeHarnessRuntime(deps, command)).pipe(
        Stream.provideService(OpenRouterModels, openRouterModels),
        Stream.provideService(ContextWindowLookup, contextWindowLookup)
      );
    const invokeCompaction = makeCompactionInvoker({
      contextWindowLookup,
      deps,
      openRouterModels,
    });
    return AgentRunner.of({
      invoke: invokeRuntime,
      invokeCompaction,
      invokeRuntime,
    });
  })
);
export { logDiagnosticEvent, HarnessWorkspaceMaterializer };
