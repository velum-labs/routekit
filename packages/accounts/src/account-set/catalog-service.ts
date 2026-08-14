import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";
import type { DiscoveredProviderModel } from "@velum-labs/routekit-contracts/provider-discovery";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { SubscriptionPoolMember } from "../subscription-pool-selection.js";

export class AccountCatalogService<M extends SubscriptionMode> {
  constructor(
    private readonly members: SubscriptionPoolMember[],
    private readonly metadata: Map<string, ModelCapabilityMetadata>,
    private readonly selectionSignals: Map<string, ModelSelectionSignals>,
    private readonly reasoning: Map<string, ModelReasoningCapabilities>,
    private readonly ensureFresh: (
      member: SubscriptionPoolMember,
      signal?: AbortSignal
    ) => Effect.Effect<void, Error, RouteKitPlatform>,
    private readonly discoverMemberModels: (
      member: SubscriptionPoolMember,
      signal?: AbortSignal
    ) => Effect.Effect<readonly DiscoveredProviderModel[], Error, RouteKitPlatform>,
    private readonly markCatalogReady: () => void
  ) {}

  discoverModels(signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      const previousMetadata = new Map(self.metadata);
      const previousSelectionSignals = new Map(self.selectionSignals);
      const previousReasoning = new Map(self.reasoning);
      self.metadata.clear();
      self.selectionSignals.clear();
      self.reasoning.clear();
      const discoveries = yield* Effect.all(
        self.members.map((member) =>
          Effect.gen(function* () {
            yield* self.ensureFresh(member, signal);
            const discovered = yield* self.discoverMemberModels(member, signal);
            member.models = new Set(discovered.map((model) => model.id));
            return discovered;
          }).pipe(Effect.orElseSucceed(() => undefined))
        ),
        { concurrency: "unbounded" }
      );
      for (const discovered of discoveries) {
        if (discovered === undefined) continue;
        for (const model of discovered) {
          if (model.metadata !== undefined && !self.metadata.has(model.id))
            self.metadata.set(model.id, model.metadata);
          if (model.createdAt !== undefined || model.providerPriority !== undefined) {
            const existing = self.selectionSignals.get(model.id);
            self.selectionSignals.set(model.id, {
              ...(existing?.createdAt !== undefined
                ? { createdAt: existing.createdAt }
                : model.createdAt !== undefined
                  ? { createdAt: model.createdAt }
                  : {}),
              ...(existing?.providerPriority !== undefined
                ? { providerPriority: existing.providerPriority }
                : model.providerPriority !== undefined
                  ? { providerPriority: model.providerPriority }
                  : {})
            });
          }
          if (model.reasoning !== undefined && !self.reasoning.has(model.id))
            self.reasoning.set(model.id, model.reasoning);
        }
      }
      const served = new Set(self.listModelIds());
      for (const [model, value] of previousMetadata)
        if (served.has(model) && !self.metadata.has(model)) self.metadata.set(model, value);
      for (const [model, value] of previousSelectionSignals)
        if (served.has(model) && !self.selectionSignals.has(model))
          self.selectionSignals.set(model, value);
      for (const [model, value] of previousReasoning)
        if (served.has(model) && !self.reasoning.has(model)) self.reasoning.set(model, value);
      self.markCatalogReady();
      return self.listModelIds();
    });
  }

  listModelIds(): readonly string[] {
    const models = new Set<string>();
    for (const member of this.members) for (const model of member.models) models.add(model);
    return [...models];
  }
  reasoningCapabilities(model: string): ModelReasoningCapabilities | undefined {
    return this.reasoning.get(model);
  }
  modelMetadata(model: string): ModelCapabilityMetadata | undefined {
    return this.metadata.get(model);
  }
  modelSelectionSignals(model: string): ModelSelectionSignals | undefined {
    return this.selectionSignals.get(model);
  }
}
