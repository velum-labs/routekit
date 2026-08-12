import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";
import type { DiscoveredProviderModel } from "@velum-labs/routekit-contracts/provider-discovery";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import type { SubscriptionProvider } from "../provider.js";
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
    ) => Promise<void>,
    private readonly discoverMemberModels: (
      member: SubscriptionPoolMember,
      signal?: AbortSignal
    ) => Promise<readonly DiscoveredProviderModel[]>,
    private readonly markCatalogReady: () => void
  ) {}

  async discoverModels(signal?: AbortSignal): Promise<readonly string[]> {
    const previousMetadata = new Map(this.metadata);
    const previousSelectionSignals = new Map(this.selectionSignals);
    const previousReasoning = new Map(this.reasoning);
    this.metadata.clear();
    this.selectionSignals.clear();
    this.reasoning.clear();
    const discoveries = await Promise.allSettled(
      this.members.map(async (member) => {
        await this.ensureFresh(member, signal);
        const discovered = await this.discoverMemberModels(member, signal);
        member.models = new Set(discovered.map((model) => model.id));
        return discovered;
      })
    );
    for (const discovery of discoveries) {
      if (discovery.status !== "fulfilled") continue;
      for (const model of discovery.value) {
        if (model.metadata !== undefined && !this.metadata.has(model.id))
          this.metadata.set(model.id, model.metadata);
        if (model.createdAt !== undefined || model.providerPriority !== undefined) {
          const existing = this.selectionSignals.get(model.id);
          this.selectionSignals.set(model.id, {
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
        if (model.reasoning !== undefined && !this.reasoning.has(model.id))
          this.reasoning.set(model.id, model.reasoning);
      }
    }
    const served = new Set(this.listModelIds());
    for (const [model, value] of previousMetadata)
      if (served.has(model) && !this.metadata.has(model)) this.metadata.set(model, value);
    for (const [model, value] of previousSelectionSignals)
      if (served.has(model) && !this.selectionSignals.has(model))
        this.selectionSignals.set(model, value);
    for (const [model, value] of previousReasoning)
      if (served.has(model) && !this.reasoning.has(model)) this.reasoning.set(model, value);
    this.markCatalogReady();
    return this.listModelIds();
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
