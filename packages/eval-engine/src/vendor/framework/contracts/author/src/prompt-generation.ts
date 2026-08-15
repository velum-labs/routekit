import type { FeatureLogger } from "./feature-logger.ts";
import type { StateStore, StoreResolver } from "./stores.ts";

export interface PromptContext {
  /** Diagnostic logger pre-scoped to the owning feature (RFC 0011). */
  readonly logger?: FeatureLogger | undefined;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
  readonly state: StateStore;
  readonly stores?: StoreResolver | undefined;
}

export type PromptExport = PromptProvider | readonly PromptProvider[];

export interface PromptFrontmatter {
  readonly name?: string | undefined;
  readonly order?: number | string | undefined;
  readonly section?: string | undefined;
}

export type PromptFragment =
  | string
  | {
      readonly name?: string | undefined;
      readonly order?: number | undefined;
      readonly section?: string | undefined;
      readonly text: string;
    };

export type PromptProvider = (
  ctx: PromptContext
) =>
  | PromptFragment
  | readonly PromptFragment[]
  | Promise<PromptFragment | readonly PromptFragment[]>;

export interface PromptModuleMetadata {
  readonly name?: string | undefined;
  readonly order?: number | undefined;
}
