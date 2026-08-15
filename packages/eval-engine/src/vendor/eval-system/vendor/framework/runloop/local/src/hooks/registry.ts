import { Context, Function as F, Layer, Schema } from "effect";

import type { HookHandlerContext } from "../../../../contracts/author/src/hooks.ts";
import type { HookController } from "../../../../contracts/author/src/hooks-handles.ts";
import type { StoreResolver } from "../../../../contracts/author/src/stores.ts";
import type { ApiRegistryEntry } from "../../../../contracts/internal/src/author-schemas/api.ts";
import type { HooksRegistryEntry } from "../contributions/hooks.ts";
import type { BootDiagnostic } from "../feature-boot/diagnostic-types.ts";

import {
  HOOK_CONTROLLER,
  HookFlavor,
} from "../../../../contracts/author/src/hooks-handles.ts";
import { FunctionSchema } from "../../../../contracts/internal/src/function-schema.ts";
import { makeContributionBootDiagnostic } from "../feature-boot/diagnostic-record.ts";

interface HookProvider {
  readonly controller: HookController<unknown>;
  readonly flavor: HookFlavor;
  readonly providerFeatureId: string;
}

interface HookHandle {
  readonly [HOOK_CONTROLLER]: HookController<unknown>;
}

interface PlannedHookRegistration {
  readonly consumerFeatureId: string;
  readonly handler: unknown;
  readonly provider: HookProvider;
}

const isHookHandle = (value: unknown): value is HookHandle =>
  typeof value === "object" && value !== null && HOOK_CONTROLLER in value;

// `isHookHandle` only confirms the symbol key is present; the value behind it
// is still `unknown` at runtime (a feature could hand us anything), so this
// re-checks the actual controller shape before trusting its methods. A struct
// of the load-bearing fields only (not the full HookController, which also
// carries mutable state like `enabled`/`handlers` a schema shouldn't model) —
// `appendHandler`/`enable`/`reset`/`setHookName` are opaque functions checked
// via the shared FunctionSchema, and `flavor` is the real domain literal.
const HookControllerShapeSchema = Schema.Struct({
  appendHandler: FunctionSchema,
  enable: FunctionSchema,
  flavor: HookFlavor,
  reset: FunctionSchema,
  setHookName: FunctionSchema,
});
const isValidHookController = Schema.is(HookControllerShapeSchema);

export interface HookRegistryShape {
  readonly arm: (stores?: StoreResolver) => void;
  readonly entries: readonly (HookProvider & { readonly name: string })[];
  readonly diagnostics: readonly BootDiagnostic[];
  readonly subscriptions: readonly {
    readonly consumerFeatureId: string;
    readonly key: string;
  }[];
}

/**
 * The plan of provider controllers and validated subscriptions for one feature
 * boot: the registry port over the boot-time hook wiring. Every feature that
 * declares `api.hooks` (a provider) or subscribes to one (a consumer) is wired
 * here so the daemon can arm the controllers once the stores resolve.
 *
 * This is a pure port. The wiring itself is synchronous ({@link
 * wireHookContributions}), so the effectful adapter that builds a registry from
 * a boot's providers/consumers lives in `HookRegistryLive`
 * (`hook-registry-live.ts`); {@link HookRegistry.layerTest} provides an inert
 * stand-in that wires nothing.
 */
export class HookRegistry extends Context.Service<
  HookRegistry,
  HookRegistryShape
>()("routekit-eval/runtime/HookRegistry") {
  /**
   * Test seam: a `HookRegistry` that wired no providers or consumers — `arm` is
   * a no-op and every listing is empty. Override only the fields a case needs;
   * the wiring adapter that plans real controllers lives in `HookRegistryLive`
   * (`hook-registry-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<HookRegistryShape>
  ): Layer.Layer<HookRegistry> =>
    Layer.succeed(HookRegistry)(
      HookRegistry.of({
        arm: F.constVoid,
        diagnostics: [],
        entries: [],
        subscriptions: [],
        ...impl,
      })
    );
}

const nearestHook = (
  key: string,
  known: readonly string[]
): string | undefined => {
  const [provider, name] = key.split(".", 2);
  return known.find(
    (candidate) =>
      candidate.startsWith(`${provider}.`) ||
      candidate.endsWith(`.${name ?? ""}`)
  );
};

const invalidHandleDiagnostic = (
  featureId: string,
  key: string
): BootDiagnostic =>
  makeContributionBootDiagnostic({
    code: "ROUTEKIT_EVAL_BOOT_HOOK_PROVIDER_INVALID",
    contributionName: "hooks",
    entryKey: key,
    featureId,
    level: "error",
    message: `api.hooks entry "${key}" of feature "${featureId}" is not a hook handle created by createHook or createPipelineHook`,
  });

const makeProviderRegistry = (
  apis: readonly ApiRegistryEntry[]
): {
  readonly diagnostics: readonly BootDiagnostic[];
  readonly providers: Map<string, HookProvider>;
} => {
  const diagnostics: BootDiagnostic[] = [];
  const providers = new Map<string, HookProvider>();
  for (const entry of apis) {
    for (const [name, value] of Object.entries(entry.api.hooks ?? {})) {
      if (!isHookHandle(value)) {
        diagnostics.push(invalidHandleDiagnostic(entry.featureId, name));
        continue;
      }
      const controller = value[HOOK_CONTROLLER];
      if (!isValidHookController(controller)) {
        diagnostics.push(invalidHandleDiagnostic(entry.featureId, name));
        continue;
      }
      const fullName = `${entry.featureId}.${name}`;
      providers.set(fullName, {
        controller,
        flavor: controller.flavor,
        providerFeatureId: entry.featureId,
      });
    }
  }
  return {
    diagnostics,
    providers,
  };
};

const registerHookSubscription = (input: {
  readonly dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>;
  readonly featureId: string;
  readonly handler: unknown;
  readonly key: string;
  readonly providers: ReadonlyMap<string, HookProvider>;
}):
  | BootDiagnostic
  | {
      readonly consumerFeatureId: string;
      readonly handler: unknown;
      readonly provider: HookProvider;
    } => {
  const provider = input.providers.get(input.key);
  if (provider === undefined) {
    const suggestion = nearestHook(input.key, [...input.providers.keys()]);
    return makeContributionBootDiagnostic({
      code: "ROUTEKIT_EVAL_BOOT_HOOK_SUBSCRIPTION_INVALID",
      contributionName: "hooks",
      entryKey: input.key,
      featureId: input.featureId,
      level: "error",
      message: `feature "${input.featureId}" subscribes to unknown hook "${input.key}"${suggestion === undefined ? "" : `; did you mean "${suggestion}"?`}`,
    });
  }
  const { providerFeatureId } = provider;
  const dependencies = input.dependenciesByFeature.get(input.featureId);
  if (
    providerFeatureId !== input.featureId &&
    !dependencies?.has(providerFeatureId)
  ) {
    return makeContributionBootDiagnostic({
      code: "ROUTEKIT_EVAL_BOOT_HOOK_DEPENDENCY_INVALID",
      contributionName: "hooks",
      entryKey: input.key,
      featureId: input.featureId,
      level: "error",
      message: `feature "${input.featureId}" subscribes to hook "${input.key}" without declaring a dependency on provider "${providerFeatureId}"`,
    });
  }
  return {
    consumerFeatureId: input.featureId,
    handler: input.handler,
    provider,
  };
};

const planHookSubscriptions = (input: {
  readonly bootOrder: readonly string[];
  readonly consumers: readonly HooksRegistryEntry[];
  readonly dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>;
  readonly providers: ReadonlyMap<string, HookProvider>;
}): {
  readonly diagnostics: readonly BootDiagnostic[];
  readonly registrations: readonly PlannedHookRegistration[];
  readonly subscriptions: readonly {
    readonly consumerFeatureId: string;
    readonly key: string;
  }[];
} => {
  const diagnostics: BootDiagnostic[] = [];
  const registrations: PlannedHookRegistration[] = [];
  const subscriptions: {
    consumerFeatureId: string;
    key: string;
  }[] = [];
  const consumers = new Map(
    input.consumers.map((record) => [record.featureId, record.hooks])
  );
  for (const featureId of input.bootOrder) {
    const hooks = consumers.get(featureId);
    if (hooks === undefined) {
      continue;
    }
    for (const [key, handler] of Object.entries(hooks)) {
      const result = registerHookSubscription({
        dependenciesByFeature: input.dependenciesByFeature,
        featureId,
        handler,
        key,
        providers: input.providers,
      });
      if ("provider" in result) {
        registrations.push(result);
        subscriptions.push({
          consumerFeatureId: featureId,
          key,
        });
      } else {
        diagnostics.push(result);
      }
    }
  }
  return {
    diagnostics,
    registrations,
    subscriptions,
  };
};

export interface HookContributionsInput {
  readonly apis: readonly ApiRegistryEntry[];
  readonly consumers: readonly HooksRegistryEntry[];
  readonly dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>;
  readonly bootOrder: readonly string[];
  readonly contextFor: (
    featureId: string,
    stores?: StoreResolver
  ) => () => HookHandlerContext;
}

export const wireHookContributions = (
  input: HookContributionsInput
): HookRegistryShape => {
  const providerRegistry = makeProviderRegistry(input.apis);
  const plan = planHookSubscriptions({
    bootOrder: input.bootOrder,
    consumers: input.consumers,
    dependenciesByFeature: input.dependenciesByFeature,
    providers: providerRegistry.providers,
  });
  return {
    arm: (stores) => {
      for (const [name, provider] of providerRegistry.providers) {
        provider.controller.reset();
        provider.controller.setHookName(name);
      }
      for (const {
        consumerFeatureId,
        handler,
        provider,
      } of plan.registrations) {
        provider.controller.appendHandler({
          context: input.contextFor(consumerFeatureId, stores),
          handler,
        });
      }
      for (const provider of providerRegistry.providers.values()) {
        provider.controller.enable();
      }
    },
    diagnostics: [...providerRegistry.diagnostics, ...plan.diagnostics],
    entries: [...providerRegistry.providers.entries()].map(
      ([name, provider]) => ({
        ...provider,
        name,
      })
    ),
    subscriptions: plan.subscriptions,
  };
};
