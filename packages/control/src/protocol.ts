import type {
  AccountReadinessReason,
  CodexModelCandidate,
  ModelCapabilityMetadata,
  ModelCallStatus,
  ModelUsage,
  ProviderErrorKind,
  RequestBillingMode,
  UpstreamAuthState
} from "@velum-labs/routekit-contracts";
import type { ControlHandlerContext } from "@velum-labs/routekit-runtime";
import type {
  CommandCompletedProperties,
  TelemetryCategory,
  TelemetryStatus
} from "@velum-labs/routekit-telemetry-core";
export const ROUTEKIT_CONTROL_CAPABILITY = "routekit.control.v1";
export const ROUTEKIT_DAEMON_ROLL_CAPABILITY = "routekit.daemon-host.v1";

export type RouteKitControlMethod =
  | "daemon.status"
  | "daemon.reload"
  | "daemon.roll"
  | "daemon.prepareShutdown"
  | "config.get"
  | "config.update"
  | "config.import"
  | "providers.status"
  | "providers.set"
  | "models.list"
  | "models.info"
  | "calls.inspect"
  | "calls.leaderboard"
  | "accounts.list"
  | "accounts.status"
  | "accounts.enroll"
  | "accounts.enrollActivate"
  | "accounts.remove"
  | "accounts.rename"
  | "accounts.sync"
  | "accounts.usage"
  | "accounts.resetCredits"
  | "accounts.redeemReset"
  | "telemetry.get"
  | "telemetry.set"
  | "telemetry.resetIdentity"
  | "telemetry.schema"
  | "telemetry.captureCommand"
  | "doctor.run"
  | "launcher.prepare"
  | "tokens.issue"
  | "tokens.list"
  | "tokens.revoke";

export type TokenPlane = "data" | "control";
export type TokenRole = "owner" | "admin";

export type TokenListEntry = {
  id: string;
  label: string;
  plane: TokenPlane;
  role: TokenRole;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type IssuedTokenResult = {
  id: string;
  label: string;
  plane: TokenPlane;
  role: TokenRole;
  /** Plaintext credential; shown once at issue time. */
  token: string;
  /**
   * Self-describing peer enrollment credential (control plane only).
   * Encodes the owner's public-record path with the control secret so a peer
   * can run `routekit peer add <joinCredential>` with no location flag.
   */
  joinCredential?: string;
};

export type RouteKitControlParams = {
  "daemon.status": Record<string, never>;
  "daemon.reload": { expectedRevision?: number };
  "daemon.roll": {
    reason: "restart" | "upgrade";
    expectedGeneration: number;
    candidate?: { binPath: string; expectedVersion: string };
  };
  "daemon.prepareShutdown": { reason: "stop" | "restart" | "upgrade" };
  "config.get": Record<string, never>;
  "config.update": { expectedRevision: number; document: string };
  "config.import": { expectedRevision: number; document: string; source?: string };
  "providers.status": { live?: boolean };
  "providers.set": { provider: string; enabled: boolean; idempotencyKey?: string };
  "models.list": { provider?: string; refresh?: boolean };
  "models.info": { model: string };
  "calls.inspect": { callId: string };
  "calls.leaderboard": {
    by?: "principal" | "model" | "provider";
    sort?: "cost" | "requests" | "tokens" | "errors" | "latency";
    limit?: number;
    window?: "live" | "1h" | "24h" | "7d";
  };
  "accounts.list": Record<string, never>;
  "accounts.status": Record<string, never>;
  "accounts.enroll": {
    kind: "claude-code" | "codex";
    label: string;
    credential: unknown;
  };
  /** Atomically import connector credentials and enable their router provider. */
  "accounts.enrollActivate": {
    kind: string;
    accounts: Array<{ label: string; credential?: unknown }>;
  };
  /** Registry kind or the raw kind returned by accounts.list for an unclassified file. */
  "accounts.remove": { kind: string; label: string };
  /** Rename a native subscription account without re-enrolling its credential. */
  "accounts.rename": {
    kind: "claude-code" | "codex";
    source: string;
    target: string;
  };
  /** Rescan connector account stores and reconcile the managed sidecar. */
  "accounts.sync": Record<string, never>;
  "accounts.usage": Record<string, never>;
  /** List banked Codex rate-limit resets for one enrolled account. */
  "accounts.resetCredits": { kind: "codex"; label: string };
  /** Redeem a banked Codex rate-limit reset for one enrolled account. */
  "accounts.redeemReset": {
    kind: "codex";
    label: string;
    creditId?: string;
    redeemRequestId?: string;
  };
  "telemetry.get": Record<string, never>;
  "telemetry.set": {
    enabled?: boolean;
    category?: TelemetryCategory;
    categoryEnabled?: boolean;
  };
  "telemetry.resetIdentity": Record<string, never>;
  "telemetry.schema": Record<string, never>;
  "telemetry.captureCommand": CommandCompletedProperties;
  "doctor.run": Record<string, never>;
  "launcher.prepare": {
    tool: "codex" | "claude" | "cursor" | "opencode";
    model?: string;
    cwd?: string;
  };
  "tokens.issue": {
    label: string;
    plane: TokenPlane;
    createdBy?: string;
  };
  "tokens.list": { plane?: TokenPlane };
  "tokens.revoke": { id: string };
};

export type DaemonStatus = {
  pid: number;
  workerPid: number;
  hostPid: number;
  hostStartedAt: string;
  startedAt: string;
  packageVersion: string;
  protocolVersion: string;
  hostProtocolVersion: number;
  generation: number;
  configRevision: number;
  accountRevision: number;
  controlUrl: string;
  dataUrl: string;
  dataPort: number;
  supervisor: string;
  draining: boolean;
  rolling: boolean;
};

export type ConfigSnapshot = {
  path: string;
  document: string;
  revision: number;
  sources: readonly ["global"];
};

export type ModelInfo = {
  id: string;
  provider?: string;
  owned_by?: string;
  created?: number;
  routekit_provider_priority?: number;
  capabilities?: Record<string, unknown>;
  architecture?: {
    modality?: string | null;
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  supported_parameters?: unknown;
  reasoning?: Record<string, unknown>;
};

export type ModelAccountClass = "api-key" | "subscription" | "proxy";
export type ModelBillingMode = "metered-api" | "subscription" | "upstream-managed";

/**
 * Secret-free explanation of one effective RouteKit model route.
 *
 * The contract deliberately excludes account labels, filesystem paths,
 * credential environment values, and transport authentication material.
 */
export type ModelRouteInfo = {
  id: string;
  provider: string;
  nativeModel: string;
  accountClass: ModelAccountClass;
  billingMode: ModelBillingMode;
  default: boolean;
  capabilities: Record<string, unknown>;
  metadata?: ModelCapabilityMetadata;
  reasoning: Record<string, unknown> | null;
};

export type LaunchPreparation = {
  tool: "codex" | "claude" | "cursor" | "opencode";
  model: string;
  gatewayUrl: string;
  authToken?: string;
  env: Record<string, string>;
  codexSelection?: {
    compatibleModelIds: string[];
    models: CodexModelCandidate[];
  };
};

export type RouteKitCallInspection = {
  callId: string;
  status: ModelCallStatus;
  effectiveModel: string;
  nativeModel?: string;
  provider: string;
  billingMode: RequestBillingMode;
  account?: { seat: string };
  principal?: { tokenId: string; label?: string };
  retries: {
    attempts: number;
    total: number;
    accountFailovers: number;
  };
  usage?: ModelUsage;
  cost: {
    estimateUsd?: number;
    unknownUsage: boolean;
    unknownCost: boolean;
  };
  timing: {
    startedAt: string;
    finishedAt?: string;
    latencyMs?: number;
  };
  error?: {
    kind: ProviderErrorKind;
    retryable?: boolean;
  };
};

export type RouteKitLeaderboardRow = {
  rank: number;
  key: string;
  label?: string;
  requests: number;
  success: number;
  error: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  estimateUsd?: number;
  unknownCostCount: number;
  unknownUsageCount: number;
  latencyMsAvg?: number;
  latencyMsP50?: number;
  latencyMsP95?: number;
};

export type RouteKitLeaderboard = {
  by: "principal" | "model" | "provider";
  sort: "cost" | "requests" | "tokens" | "errors" | "latency";
  source: "live" | "durable";
  window: { start: string; end: string };
  sampleSize: number;
  truncated: boolean;
  budget: {
    liveLimit: number;
    liveTtlHours: number;
    durable: boolean;
    durableRetentionDays: number;
  };
  rows: RouteKitLeaderboardRow[];
};

export type RouteKitRateLimitObservationSource = "headers" | "response" | "usage" | "stream";

export type RouteKitResetCredit = {
  id: string;
  resetType?: string;
  status?: string;
  grantedAt?: number;
  expiresAt?: number;
  title?: string;
  description?: string;
};

export type RouteKitResetCreditSnapshot = {
  observedAt: number;
  availableCount: number;
  credits?: RouteKitResetCredit[];
};

export type RouteKitAccountLimits = {
  windows: Record<
    string,
    {
      utilization: number;
      status?: string;
      resetsAt?: number;
      windowSeconds?: number;
      limitName?: string;
      observedAt: number;
      source: RouteKitRateLimitObservationSource;
    }
  >;
  planType?: string;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
  resetCredits?: RouteKitResetCreditSnapshot;
  observedAt: number;
  source: RouteKitRateLimitObservationSource;
  completeness: "snapshot" | "partial";
};

export type RouteKitAccountMemberStatus = {
  id: string;
  mode: "claude-code" | "codex";
  label: string;
  sourcePath: string;
  expiresAt?: number;
  coolingUntil?: number;
  serving: boolean;
  inFlight: number;
  lastSelectedAt?: number;
  lastSelected: boolean;
  /** @deprecated Compatibility alias for `lastSelected`. */
  active: boolean;
  credentialValid?: boolean;
  upstreamAuthState?: UpstreamAuthState;
  relayReady?: boolean;
  poolEligible?: boolean;
  readinessReasons?: AccountReadinessReason[];
  models: string[];
  limits?: RouteKitAccountLimits;
};

export type RouteKitAccountUsage = {
  accountSets: Array<{
    mode: "claude-code" | "codex";
    strategy: "sticky" | "round_robin" | "capacity_weighted";
    switchThreshold: number;
    members: RouteKitAccountMemberStatus[];
  }>;
};

export type RouteKitAccountStatusEntry = {
  subscriptionKind: string;
  label: string;
  connector: "native" | "cliproxy";
  localOnly?: boolean;
  credentialValid: boolean;
  upstreamAuthState?: UpstreamAuthState;
  configured: boolean;
  relayOpen: boolean;
  serving: boolean;
  inFlight: number;
  lastSelectedAt?: number;
  lastSelected: boolean;
  /** @deprecated Compatibility alias for `lastSelected`. */
  active: boolean;
  readinessReasons?: AccountReadinessReason[];
  models: string[];
  limits?: RouteKitAccountLimits;
};

export type RouteKitControlResults = {
  "daemon.status": DaemonStatus;
  "daemon.reload": { reloaded: true; configRevision: number; accountRevision: number };
  "daemon.roll": {
    rolled: true;
    reason: "restart" | "upgrade";
    previousGeneration: number;
    generation: number;
    previousWorkerPid: number;
    workerPid: number;
    packageVersion: string;
  };
  "daemon.prepareShutdown": { accepted: true };
  "config.get": ConfigSnapshot;
  "config.update": ConfigSnapshot;
  "config.import": ConfigSnapshot;
  "providers.status": {
    providers: Array<{
      provider: string;
      configured: boolean;
      credentialAvailable: boolean;
      models?: readonly string[];
      error?: string;
    }>;
  };
  "providers.set": ConfigSnapshot;
  "models.list": { models: ModelInfo[]; defaultModel?: string; revision: number };
  "models.info": ModelRouteInfo;
  "calls.inspect": RouteKitCallInspection;
  "calls.leaderboard": RouteKitLeaderboard;
  "accounts.list": { accounts: unknown[]; revision: number };
  "accounts.status": {
    accounts: RouteKitAccountStatusEntry[];
    revision: number;
    recovery: {
      state: "clean" | "recovered";
      recovered: number;
      cleaned: number;
    };
  };
  "accounts.enroll": { enrolled: true; revision: number };
  "accounts.enrollActivate": {
    enrolled: Array<{ subscriptionKind: string; label: string }>;
    activated: true;
    configPath: string;
    configRevision: number;
    accountRevision: number;
  };
  "accounts.remove": { removed: boolean; revision: number };
  "accounts.rename": { renamed: true; revision: number };
  "accounts.sync": { synced: true; revision: number };
  "accounts.usage": RouteKitAccountUsage;
  "accounts.resetCredits": {
    kind: "codex";
    label: string;
    resetCredits: RouteKitResetCreditSnapshot;
  };
  "accounts.redeemReset": {
    ok: boolean;
    code: string;
    kind: "codex";
    label: string;
    redeemRequestId: string;
    creditId?: string;
    windowsReset?: number;
    usage: RouteKitAccountUsage;
  };
  "telemetry.get": TelemetryStatus;
  "telemetry.set": TelemetryStatus;
  "telemetry.resetIdentity": TelemetryStatus;
  "telemetry.schema": TelemetryStatus["schema"];
  "telemetry.captureCommand": { accepted: boolean };
  "doctor.run": { checks: Array<{ name: string; ok: boolean; detail?: string }> };
  "launcher.prepare": LaunchPreparation;
  "tokens.issue": IssuedTokenResult;
  "tokens.list": { tokens: TokenListEntry[] };
  "tokens.revoke": TokenListEntry;
};

export type RouteKitMethodHandler<M extends RouteKitControlMethod> = (
  params: RouteKitControlParams[M],
  context: ControlHandlerContext
) => RouteKitControlResults[M] | Promise<RouteKitControlResults[M]>;

export type RouteKitControlHandlers = {
  [M in RouteKitControlMethod]: RouteKitMethodHandler<M>;
};
