import type {
  AgentRuntimeEvent,
  ElicitationFieldSummary,
  PermissionOptionKind,
} from "./agent-event.ts";
import type {
  AGENT_SESSION_CONTENT_ROLES,
  AGENT_SESSION_LIFECYCLE_EVENTS,
  AGENT_SESSION_RUNTIME_ITEM_TYPES,
  AGENT_SESSION_TOOL_STATUSES,
  AgentSessionItemStatus,
} from "./agent-session/index.ts";
import type { FeatureLogger } from "./feature-logger.ts";
import type { AgentParameters } from "./parameters.ts";
import type { StateStore, StoreResolver } from "./stores.ts";
import type { ValueOf } from "../../../utils/core/src/types.ts";

export type HarnessCompactionOptions = Omit<
  HarnessInvokeOptions,
  "outputSchema" | "prompt"
>;

export type HarnessPromptOptions = HarnessInvokeOptions;

export type AgentSessionToolStatus =
  (typeof AGENT_SESSION_TOOL_STATUSES)[number];

export type AgentSessionId = string & { readonly __agentSessionId?: never };
export type AgentResumeToken = string & { readonly __agentResumeToken?: never };

export type AgentSessionEvent =
  | {
      readonly event: "content.delta";
      readonly delta: string;
      readonly role: (typeof AGENT_SESSION_CONTENT_ROLES)[number];
      readonly contentIndex?: number | undefined;
      readonly itemId?: string | undefined;
    }
  | {
      readonly event: "tool.started";
      readonly input?: unknown;
      readonly name: string;
      readonly toolCallId?: string | undefined;
    }
  | {
      readonly event: "tool.updated";
      readonly input?: unknown;
      readonly name?: string | undefined;
      readonly output?: unknown;
      readonly status?: AgentSessionToolStatus | undefined;
      readonly toolCallId?: string | undefined;
    }
  | {
      readonly event: "item";
      readonly data?: unknown;
      readonly itemId?: string | undefined;
      readonly itemType: string;
      readonly status?: AgentSessionItemStatus | undefined;
    }
  | {
      readonly event: (typeof AGENT_SESSION_RUNTIME_ITEM_TYPES)[number];
      readonly data: unknown;
    }
  | {
      readonly event: (typeof AGENT_SESSION_LIFECYCLE_EVENTS)[number];
      readonly attempt?: number | undefined;
      readonly delayMs?: number | undefined;
      readonly message?: string | undefined;
      readonly trigger?: "automatic" | "manual" | "unknown" | undefined;
    };

export type AgentInteractionRequest =
  | {
      readonly kind: "permission";
      readonly correlationId: string;
      readonly operation: string;
      readonly options: readonly PermissionOptionKind[];
    }
  | {
      readonly kind: "elicitation";
      readonly correlationId: string;
      readonly message: string;
      readonly fields: readonly ElicitationFieldSummary[];
    };

export interface AgentInteractionResponse {
  readonly correlationId: string;
  readonly response:
    | {
        readonly kind: "permission";
        readonly option: PermissionOptionKind;
      }
    | {
        readonly kind: "elicitation";
        readonly values: Readonly<Record<string, unknown>>;
      };
}

export type AgentSessionEventEnvelope =
  | AgentSessionEvent
  | AgentInteractionRequest;

export interface AgentSession {
  readonly id: AgentSessionId;
  readonly prompt: (
    options: HarnessPromptOptions
  ) => AsyncIterable<AgentSessionEventEnvelope>;
  readonly release: () => Promise<void>;
  readonly resumeToken?: () => Promise<AgentResumeToken | undefined>;
  readonly interrupt?: () => Promise<void>;
  readonly respond?: (response: AgentInteractionResponse) => Promise<void>;
}

export type HarnessConnectOptions = HarnessInvokeOptions & {
  readonly resumeToken?: AgentResumeToken | undefined;
};
export type HarnessConnect = (
  options: HarnessConnectOptions
) => Promise<AgentSession>;

/** Callbacks registered by one author harness. */
export interface AgentHarnessRegistrar {
  /** Register the harness close callback. Registering it twice is an error. */
  readonly registerClose: (close: () => Promise<void>) => void;
  /** Register in-place compaction for the live session. */
  readonly registerCompaction: (
    compact: (
      options: HarnessCompactionOptions
    ) => AsyncIterable<AgentRuntimeEvent>
  ) => void;
  /** Register the prompt turn implementation. */
  readonly registerPrompt: (
    prompt: (options: HarnessInvokeOptions) => AsyncIterable<AgentRuntimeEvent>
  ) => void;
  /** Register the connection turn implementation. */
  readonly registerConnect: (connect: HarnessConnect) => void;
  /** Register an optional provider availability probe. */
  readonly registerProbe: (probe: () => Promise<string | undefined>) => void;
  /** Set the model advertised before the first turn. */
  readonly setDefaultModel: (model: string | undefined) => void;
}

/** A feature-provided harness implementation and its lifecycle metadata. */
export interface AgentHarness {
  readonly name: string;
  /** Register callbacks and metadata without starting provider work. */
  readonly init: (registrar: AgentHarnessRegistrar) => void | Promise<void>;
}

/** Type pass-through that types a feature's named `harness` export. */
export const defineHarness = (definition: AgentHarness): AgentHarness =>
  definition;

export type AgentHarnessContribution = AgentHarness;
export type AgentHarnessExport =
  | AgentHarnessContribution
  | readonly AgentHarnessContribution[];

export const HarnessType = {
  InvokeOptions: "invokeOptions",
} as const;
export type HarnessType = ValueOf<typeof HarnessType>;

/**
 * A structured-output request threaded to a harness invoke (RFC 0002 schedule.md). It
 * carries a JSON Schema (Draft 2020-12) describing the shape the run should
 * return. Agentic harnesses (pi, claude) cannot enforce it at the model, so they
 * inject it as an instruction; a future direct-model harness can pass it through
 * as a native `response_format` without changing this contract.
 */
export interface HarnessOutputSchema {
  /** Shared `$defs` pool the root schema may reference. */
  readonly definitions?: unknown;
  /** Optional name for the schema (surfaced to the model). */
  readonly name?: string | undefined;
  /** The root JSON Schema object. */
  readonly schema: unknown;
}

export interface HarnessInvokeOptions {
  /**
   * The resolved model's context-window size in tokens (OpenRouter catalog
   * `context_length`). `undefined` when the catalog does not know the model;
   * the harness then keeps its own defaults.
   */
  readonly contextWindow?: number | undefined;
  readonly cwd?: string | undefined;
  readonly disableBundledSkills?: boolean | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  /**
   * Absolute paths to framework-owned skill directories the harness should
   * load in addition to whatever it discovers from `cwd`, without writing
   * those skills into the project itself. `ori code` uses these for its
   * built-in code-practice skills and the global workspace snapshot
   * (RFC 0004 code.md).
   */
  readonly extraSkillDirs?: readonly string[] | undefined;
  readonly model?: string | null | undefined;
  readonly parameters?: AgentParameters | undefined;
  readonly outputSchema?: HarnessOutputSchema | undefined;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
  readonly resumeToken?: AgentResumeToken | undefined;
  readonly systemPrompt?: string | undefined;
  readonly temperature?: number | undefined;
  readonly type: typeof HarnessType.InvokeOptions;
  /**
   * Identity of the user this run is invoked on behalf of (ORI-361), when the
   * caller supplied one. A builtin harness reads it here to attribute or scope
   * work to the invoking user instead of parsing it out of `env` or the prompt.
   * Optional: absent when the caller did not inject a user.
   */
  readonly userId?: string | undefined;
}

export const HookType = {
  AgentRunContext: "agentRunContext",
} as const;
export type HookType = ValueOf<typeof HookType>;

export interface AgentHook {
  readonly onAfterRun?:
    | ((
        ctx: AgentRunContext,
        result: { readonly ok: boolean }
      ) => Promise<void>)
    | undefined;
  readonly onBeforeRun?:
    | ((context: AgentRunContext) => Promise<void>)
    | undefined;
  readonly onStream?:
    | ((event: AgentRuntimeEvent, context: AgentRunContext) => Promise<void>)
    | undefined;
}
export type AgentHookExport = AgentHook | readonly AgentHook[];

export interface AgentRunContext {
  /** Diagnostic logger pre-scoped to the owning feature (RFC 0011). */
  readonly logger?: FeatureLogger | undefined;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
  readonly state: StateStore;
  readonly stores?: StoreResolver | undefined;
  readonly type: typeof HookType.AgentRunContext;
}
