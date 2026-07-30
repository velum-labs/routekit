import type {
  ModelReasoningCapabilities,
  ReasoningSelection
} from "@velum-labs/routekit-contracts";
import type {
  AnyHarnessDriver,
  HarnessKind,
  ResumeCursor
} from "@velum-labs/routekit-harness-core";

export type ToolModelFeature = "streaming" | "tools" | "images" | "reasoning_controls";
export type ToolCapabilityGrade = "full" | "degraded" | "unsupported";
export type ToolModelFeatureStatus = ToolCapabilityGrade | "unknown";

/** An opaque gateway model entry. Launchers never interpret the id. */
export type ToolModel = {
  id: string;
  label?: string;
  /** Provider that supplied this model, when known from live discovery. */
  provider?: string;
  aliases?: readonly string[];
  features?: Partial<Record<ToolModelFeature, ToolModelFeatureStatus>>;
  reasoning?: ModelReasoningCapabilities;
};

/** A host-authored generic agent definition serialized by each launcher. */
export type AgentProfile = {
  id: string;
  model: string;
  description: string;
  instructions: string;
};

/** RouteKit-owned native session action for one tool launch. */
export type ToolSessionIntent = { mode: "new" } | { mode: "resume"; cursor: ResumeCursor };

export type ToolLaunchResult = {
  exitCode: number;
  /** The native cursor created or resumed by this launch, when supported. */
  resumeCursor?: ResumeCursor;
};

export type ToolNativeRemovalContext = {
  /** Process environment used to locate the tool's normal native state. */
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export type ToolSessionCapability =
  | {
      status: "resumable";
      removal: "forget-only";
    }
  | {
      status: "resumable";
      removal: "exact-delete";
      /** Delete exactly the native session represented by this opaque cursor. */
      removeNative(cursor: ResumeCursor, context?: ToolNativeRemovalContext): Promise<void>;
    }
  | { status: "unsupported" };

/** Portable launch data shared by RouteKit launch commands and product hosts. */
export type ToolLaunchSpec = {
  gatewayUrl: string;
  defaultModel: string;
  models: readonly ToolModel[];
  reasoning?: ReasoningSelection;
  agentProfiles?: readonly AgentProfile[];
  args: readonly string[];
  cwd?: string;
  auth?: { token?: string };
  tls?: { caCertPath?: string };
  logsDir?: string;
  publicUrl?: string;
  /** Present only when the host is managing native session identity. */
  session?: ToolSessionIntent;
};

/** Host lifecycle services paired with one neutral launch specification. */
export type ToolLaunchContext = {
  spec: ToolLaunchSpec;
  log: (line: string) => void;
  prepareForPassthrough: () => void;
  registerPort: (name: string, port: number) => string;
  unregisterPort: (name: string) => void;
  registerDisposer: (dispose: () => void | Promise<void>) => void;
  /** Publish a durable native cursor as soon as its identity is known. */
  publishResumeCursor?: (cursor: ResumeCursor) => void | Promise<void>;
};

export type ToolDriverRoute = {
  gatewayUrl: string;
  model: string;
  authToken?: string;
};

export type ToolDriverMetadata = {
  kind: HarnessKind;
  driver: AnyHarnessDriver;
  configForRoute(route: ToolDriverRoute): unknown;
};

export type ToolCapabilityMetadata = {
  streaming: ToolCapabilityGrade;
  tools: ToolCapabilityGrade;
  images: ToolCapabilityGrade;
  reasoning_controls: ToolCapabilityGrade;
};

/** One neutral launcher plus the canonical driver and static metadata. */
export type ToolIntegration = {
  /** Stable id (e.g. "codex"). */
  id: string;
  /** Alternate selectors that resolve to this tool. */
  aliases?: readonly string[];
  /** Human-facing name for pickers and dashboards. */
  displayName: string;
  /** One-line hint shown in the interactive picker. */
  pickerHint: string;
  /** The PATH binary launched, when the tool spawns one. */
  binary?: string;
  /** The npm package implementing this integration. */
  packageName: string;
  /** How to install the tool binary (doctor/preflight guidance). */
  installHint?: string;
  /** One-line authentication summary. */
  authSummary?: string;
  /**
   * Front-door setup block for pointing this tool at a running gateway
   * (rendered by `gatewaySetupSnippets`). `note` carries tool-specific extra
   * context.
   */
  setupSnippet?: (input: { gatewayUrl: string; model?: string; note?: string }) => string;
  /** Native session support and removal semantics for this public launcher. */
  session: ToolSessionCapability;
  /** Boot the tool against the host context and return its structured result. */
  launch(ctx: ToolLaunchContext): Promise<ToolLaunchResult>;
  driver: ToolDriverMetadata;
  capabilities: ToolCapabilityMetadata;
};
