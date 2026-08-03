/**
 * Singleton RouteKit daemon.
 *
 * One process owns a private authenticated control listener and one stable
 * model-gateway front door. Router generations run on ephemeral loopback
 * ports behind that front door; config/account reload builds a complete new
 * generation before atomically switching new traffic and draining the old.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AccountStoreEntry, SubscriptionCredential } from "@velum-labs/routekit-accounts";
import {
  AccountActivityCoordinator,
  AccountAuthCoordinator,
  accountStoreEntries,
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  cliproxyAccountEntries,
  cliproxyAccountMatchesKind,
  cliproxyApiKey,
  cliproxyAuthDirectory,
  cliproxyBaseUrl,
  cliproxyCredentialValid,
  defaultSubscriptionAccountDirectory,
  RateLimitTracker,
  removeCliproxyAccount,
  removeSubscriptionAccount,
  renameSubscriptionAccount,
  sanitizeSubscriptionLabel,
  subscriptionAccountIdentity,
  subscriptionCredentialFingerprint
} from "@velum-labs/routekit-accounts";
import {
  configuredProviderIds,
  globalRouterConfigPath,
  parseRouterConfigDocument,
  routekitHome,
  writeRouterConfig
} from "@velum-labs/routekit-config";
import type {
  ConfigSnapshot,
  DaemonStatus,
  ModelInfo,
  RouteKitControlHandlers,
  RouteKitControlMethod
} from "@velum-labs/routekit-control";
import {
  createRouteKitControlHandler,
  MUTATING_ROUTEKIT_METHODS,
  ROUTEKIT_CONTROL_CAPABILITY,
  ROUTEKIT_DAEMON_ROLL_CAPABILITY
} from "@velum-labs/routekit-control";
import type {
  LeaderboardConfig,
  RouterConfig,
  SwitchingGatewayProxy
} from "@velum-labs/routekit-gateway";
import {
  resolveCodexStartupModel,
  resolveLeaderboardConfig,
  startSwitchingGatewayProxy
} from "@velum-labs/routekit-gateway";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import {
  accountKindForCliproxyAuthType,
  PROVIDERS,
  resolveAccountConnector
} from "@velum-labs/routekit-registry";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { startRouter } from "@velum-labs/routekit-router";
import type {
  PortlessSession,
  RunningControlServer,
  ServiceRecord,
  TokenStore
} from "@velum-labs/routekit-runtime";
import {
  acquireLifecycleLock,
  CONTROL_PROTOCOL_VERSION,
  ControlClient,
  ControlError,
  createPortlessSession,
  createServiceRecordStore,
  createTokenStore,
  encodeJoinCredential,
  extendCleanupGrace,
  generateControlToken,
  nextServiceGeneration,
  processIdentity,
  registerCleanup,
  SERVICE_HOME_MODE,
  startControlServer,
  supervisorFromEnv,
  writeFileAtomic
} from "@velum-labs/routekit-runtime";
import {
  createConsentManager,
  durationBucket,
  TELEMETRY_SCHEMA_INVENTORY,
  type TelemetryEventProperties,
  telemetryStatusMetadata
} from "@velum-labs/routekit-telemetry-core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  cleanupAccountTransaction,
  markAccountTransactionCommitted,
  prepareAccountTransaction,
  recoverAccountTransactions,
  rollbackAccountTransaction
} from "./account-transaction.js";
import { CallAttributionStore, callInspection } from "./call-attribution-store.js";
import { createCliproxySidecar } from "./cliproxy-sidecar.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import { DAEMON_HOST_PROTOCOL_VERSION } from "./host-protocol.js";
import {
  aggregateInspections,
  buildLeaderboardResult,
  defaultLeaderboardWindow,
  LeaderboardRollupStore
} from "./leaderboard.js";
import {
  DaemonTelemetry,
  DEFAULT_TELEMETRY_HOST,
  GatewayTelemetryAggregator,
  resolveTelemetryProjectKey,
  type TelemetryTransportFactory
} from "./telemetry.js";

export const ROUTEKIT_DAEMON_KIND = "daemon";
export const ROUTEKIT_PRODUCT = "routekit";

export type RouteKitDaemonOptions = {
  packageVersion: string;
  env?: NodeJS.ProcessEnv;
  stateHome?: string;
  configPath?: string;
  host?: string;
  port?: number;
  controlPort?: number;
  authToken?: string;
  authTokenFile?: string;
  portless?: boolean;
  drainGraceMs?: number;
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  onRollRequested?: (
    params: import("@velum-labs/routekit-control").RouteKitControlParams["daemon.roll"]
  ) => Promise<import("@velum-labs/routekit-control").RouteKitControlResults["daemon.roll"]>;
  hosted?: {
    generation: number;
    controlToken: string;
    dataUrl: () => string;
    hostPid: number;
    hostStartedAt: string;
    rolling: () => boolean;
    sidecar: CliproxySidecar;
    initiallyPaused?: boolean;
  };
  /** Test seam for a network-free telemetry transport. */
  telemetryTransportFactory?: TelemetryTransportFactory;
  telemetryFlushIntervalMs?: number;
  /** Test seam used by child-process interruption coverage. */
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};

export type RunningRouteKitDaemon = {
  record: ServiceRecord;
  dataUrl: string;
  controlUrl: string;
  close(): Promise<void>;
  retire(graceMs?: number): Promise<void>;
  pauseMutations(): Promise<{
    configRevision: number;
    accountRevision: number;
    configHash: string;
  }>;
  resumeMutations(): void;
  snapshot(): {
    configRevision: number;
    accountRevision: number;
    configHash: string;
  };
  reload(): Promise<void>;
};

function dataTokenPath(home: string): string {
  return join(home, "secrets", "data-token");
}

function redactedProcessArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--auth-token") {
      index += 1;
      result.push("--auth-token", "[REDACTED]");
    } else if (value.startsWith("--auth-token=")) {
      result.push("--auth-token=[REDACTED]");
    } else {
      result.push(value);
    }
  }
  return result;
}

function resolveDataToken(
  home: string,
  input: { authToken?: string; authTokenFile?: string },
  tokens: TokenStore
): { token: string; path: string } {
  const path = input.authTokenFile ?? dataTokenPath(home);
  const ensured = tokens.ensureOwnerDataToken({
    ...(input.authToken !== undefined ? { plaintext: input.authToken } : {}),
    legacyPath: path
  });
  if (ensured.token.length === 0) throw new Error("RouteKit data-plane token is empty");
  return { token: ensured.token, path };
}

export type DaemonPublicRecord = {
  product: string;
  kind: string;
  url: string;
  port: number;
  generation: number;
  protocolVersion: string;
  dataUrl?: string;
  dataPort?: number;
  startedAt: string;
};

export function daemonPublicRecordPath(home: string): string {
  return join(home, "services", "daemon.public.json");
}

/** Publish a secret-free discovery file peers can read across OS accounts. */
export function writeDaemonPublicRecord(home: string, record: DaemonPublicRecord): void {
  const servicesDir = join(home, "services");
  mkdirSync(home, { recursive: true, mode: SERVICE_HOME_MODE });
  chmodSync(home, SERVICE_HOME_MODE);
  mkdirSync(servicesDir, { recursive: true, mode: SERVICE_HOME_MODE });
  chmodSync(servicesDir, SERVICE_HOME_MODE);
  const path = daemonPublicRecordPath(home);
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
}

export function removeDaemonPublicRecord(home: string): void {
  rmSync(daemonPublicRecordPath(home), { force: true });
}

/**
 * Resolve (or mint) a data-plane token for the calling control principal so
 * tool launchers attribute usage to that admin rather than the owner token.
 * Plaintext is cached in-memory for the daemon lifetime.
 */
function dataTokenForPrincipal(
  tokens: TokenStore,
  cache: Map<string, string>,
  ownerToken: string,
  principal: { id: string; label: string; role: string } | undefined
): string {
  if (principal === undefined || principal.role === "ephemeral" || principal.role === "owner") {
    return ownerToken;
  }
  const label = `${principal.label}-data`;
  const cached = cache.get(label);
  if (cached !== undefined) return cached;
  const existing = tokens.findByLabel(label, "data");
  if (existing !== undefined) {
    // Registry has a hash but plaintext is gone after restart; rotate.
    tokens.revoke(existing.id);
  }
  const issued = tokens.issue({
    label,
    plane: "data",
    role: "admin",
    createdBy: principal.label
  });
  cache.set(label, issued.token);
  return issued.token;
}

type RevisionState = { config: number; accounts: number; daemon: number };

function revisionPath(home: string): string {
  return join(home, "daemon-revisions.json");
}

export function readDaemonRevisions(home: string): RevisionState {
  try {
    const parsed = JSON.parse(readFileSync(revisionPath(home), "utf8")) as Partial<RevisionState>;
    return {
      config:
        typeof parsed.config === "number" && Number.isSafeInteger(parsed.config)
          ? parsed.config
          : 0,
      accounts:
        typeof parsed.accounts === "number" && Number.isSafeInteger(parsed.accounts)
          ? parsed.accounts
          : 0,
      daemon:
        typeof parsed.daemon === "number" && Number.isSafeInteger(parsed.daemon) ? parsed.daemon : 0
    };
  } catch {
    return { config: 0, accounts: 0, daemon: 0 };
  }
}
export function writeDaemonRevisions(home: string, revisions: RevisionState): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileAtomic(revisionPath(home), `${JSON.stringify(revisions, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(revisionPath(home), 0o600);
}

function writeSnapshot(
  home: string,
  category: "catalog" | "health",
  name: string,
  value: unknown
): void {
  const directory = join(home, category);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.json`);
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function canonicalConfigDocument(path: string): string {
  if (!existsSync(path)) {
    throw new ControlError({
      code: "unavailable",
      message:
        `canonical router config not found: ${path}; run ` +
        "`routekit config init` or `routekit config import --from <path>`"
    });
  }
  return readFileSync(path, "utf8");
}

function parseConfigDocument(document: string): RouterConfig {
  try {
    return parseRouterConfigDocument(document, "daemon config update");
  } catch (error) {
    throw new ControlError({
      code: "bad_request",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
function revisionConflict(expected: number, actual: number): never {
  throw new ControlError({
    code: "conflict",
    message: `revision conflict: expected ${expected}, current ${actual}`,
    details: { expected, actual }
  });
}

type WithoutPath<T> = T extends { path: string } ? Omit<T, "path"> : never;
type AccountEntry = WithoutPath<AccountStoreEntry>;

function accountEntries(env: NodeJS.ProcessEnv): AccountEntry[] {
  return accountStoreEntries(env).map(({ path: _path, ...entry }) => entry);
}

function providerCredentialAvailable(
  provider: string,
  accounts: ReturnType<typeof accountEntries>,
  env: NodeJS.ProcessEnv
): boolean {
  if (provider === "claude-code" || provider === "codex") {
    return accounts.some((entry) => entry.subscriptionKind === provider);
  }
  if (provider === "cliproxy") {
    return (env[CLIPROXY_API_KEY_ENV] ?? "").length > 0 || cliproxyApiKey(env) !== undefined;
  }
  const info = PROVIDERS[provider];
  if (info?.keyEnv === undefined) return true;
  return (env[info.keyEnv] ?? "").length > 0;
}

function safeCredentialBlob(
  kind: "claude-code" | "codex",
  value: unknown
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "credential must be an object" });
  }
  const record = structuredClone(value as Record<string, unknown>);
  const valid =
    kind === "claude-code"
      ? typeof (record.claudeAiOauth as Record<string, unknown> | undefined)?.accessToken ===
        "string"
      : typeof (record.tokens as Record<string, unknown> | undefined)?.access_token === "string" ||
        typeof record.access_token === "string";
  if (!valid) {
    throw new ControlError({
      code: "bad_request",
      message: `credential does not have the expected ${kind} token shape`
    });
  }
  return record;
}

function safeCliproxyCredentialBlob(kind: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "credential must be an object" });
  }
  const record = structuredClone(value as Record<string, unknown>);
  const type = typeof record.type === "string" ? record.type : undefined;
  const classified =
    type === undefined
      ? undefined
      : (accountKindForCliproxyAuthType(type) ?? resolveAccountConnector(type)?.kind);
  if (classified !== kind || !cliproxyCredentialValid(record, type)) {
    throw new ControlError({
      code: "bad_request",
      message: `credential does not have the expected ${kind} connector shape`
    });
  }
  return record;
}

function safeCliproxyLabel(label: string): string {
  if (
    label.length === 0 ||
    label.startsWith(".") ||
    basename(label) !== label ||
    label.includes("\\")
  ) {
    throw new ControlError({
      code: "bad_request",
      message: "connector account label is not path-safe"
    });
  }
  return label;
}

async function healthyControl(record: ServiceRecord): Promise<boolean> {
  if (record.controlToken === undefined) return false;
  try {
    const client = new ControlClient({
      url: record.url,
      token: record.controlToken,
      timeoutMs: 1_000
    });
    const health = await client.health();
    return health.protocol === CONTROL_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

export async function startRouteKitDaemon(
  options: RouteKitDaemonOptions
): Promise<RunningRouteKitDaemon> {
  const env = options.env ?? process.env;
  const home = options.stateHome ?? routekitHome(env);
  const configPath = options.configPath ?? globalRouterConfigPath();
  const drainGraceMs = options.drainGraceMs ?? 30_000;
  const tokens = createTokenStore(home);
  const dataTokenCache = new Map<string, string>();
  const dataAuth = resolveDataToken(home, options, tokens);
  dataTokenCache.set("default", dataAuth.token);
  const store = createServiceRecordStore({ home, product: ROUTEKIT_PRODUCT });
  const hosted = options.hosted;
  // Held for the daemon's whole lifetime. Lifecycle clients use daemon.lock
  // while this authority lock prevents any second daemon from becoming live.
  const authority =
    hosted === undefined
      ? await acquireLifecycleLock(join(store.directory, "daemon-authority.lock"), {
          timeoutMs: 30_000,
          onWait: async () => {
            const existing = store.read(ROUTEKIT_DAEMON_KIND);
            return existing !== undefined && (await healthyControl(existing))
              ? new ControlError({
                  code: "conflict",
                  message: `RouteKit daemon is already running (pid ${existing.pid})`
                })
              : undefined;
          }
        })
      : undefined;
  let accountRecovery;
  try {
    accountRecovery = recoverAccountTransactions(home);
  } catch (error) {
    authority?.release();
    throw error;
  }

  let control: RunningControlServer | undefined;
  let proxy: SwitchingGatewayProxy | undefined;
  let portless: PortlessSession | undefined;
  let sidecarRef: ReturnType<typeof createCliproxySidecar> | undefined;
  let activeRouter: RunningRouter | undefined;
  let accountActivity: AccountActivityCoordinator | undefined;
  let accountAuth: AccountAuthCoordinator | undefined;
  let daemonTelemetry: DaemonTelemetry | undefined;
  let gatewayTelemetry: GatewayTelemetryAggregator | undefined;
  let record: ServiceRecord | undefined;
  let closed = false;
  let draining = false;
  let lifecycle: "running" | "paused" | "quiescing" | "draining" | "closed" =
    hosted?.initiallyPaused === true ? "paused" : "running";
  let revisions = readDaemonRevisions(home);
  let currentDocument = canonicalConfigDocument(configPath);
  let currentConfig = parseConfigDocument(currentDocument);
  let mutationTail: Promise<void> = Promise.resolve();
  const serializeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (lifecycle !== "running") {
      throw new ControlError({
        code: "unavailable",
        message: "RouteKit daemon is shutting down"
      });
    }
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return await result;
  };
  const startedAt = new Date().toISOString();

  try {
    const previous = hosted === undefined ? store.read(ROUTEKIT_DAEMON_KIND) : undefined;
    if (hosted === undefined && previous !== undefined && previous.pid !== process.pid && (await healthyControl(previous))) {
      throw new ControlError({
        code: "conflict",
        message: `RouteKit daemon is already running (pid ${previous.pid})`
      });
    }
    if (hosted === undefined && previous !== undefined && previous.pid !== process.pid) {
      // A live-but-unhealthy daemon is not safe to replace under its feet.
      throw new ControlError({
        code: "unavailable",
        message: `RouteKit daemon pid ${previous.pid} is alive but its control plane is unhealthy; stop it before recovery`
      });
    }
    const generation =
      hosted?.generation ??
      nextServiceGeneration(Math.max(previous?.generation ?? 0, revisions.daemon));
    if (hosted === undefined) {
      revisions.daemon = generation;
      writeDaemonRevisions(home, revisions);
    }
    const sidecar = hosted?.sidecar ?? createCliproxySidecar({ env });
    sidecarRef = sidecar;
    let leaderboardConfig: LeaderboardConfig = resolveLeaderboardConfig(currentConfig);
    const callAttributions = new CallAttributionStore({
      limit: leaderboardConfig.liveLimit,
      ttlMs: leaderboardConfig.liveTtlHours * 60 * 60 * 1_000
    });
    const leaderboardRollups = new LeaderboardRollupStore({
      home,
      config: leaderboardConfig
    });
    const telemetry = createConsentManager({
      path: () => join(home, "telemetry.json"),
      environmentVariable: "ROUTEKIT_TELEMETRY"
    });
    daemonTelemetry = new DaemonTelemetry({
      env,
      resolveConsent: telemetry.resolve,
      ...(options.telemetryTransportFactory !== undefined
        ? { factory: options.telemetryTransportFactory }
        : {})
    });
    gatewayTelemetry = new GatewayTelemetryAggregator({
      telemetry: daemonTelemetry,
      version: options.packageVersion,
      ...(options.telemetryFlushIntervalMs !== undefined
        ? { flushIntervalMs: options.telemetryFlushIntervalMs }
        : {})
    });
    // Independent of leaderboard durable rollups: last-selection only.
    mkdirSync(join(home, "usage"), { recursive: true, mode: 0o700 });
    accountActivity = new AccountActivityCoordinator({
      statePath: join(home, "usage", "account-activity.v1.json")
    });
    mkdirSync(join(home, "subscriptions"), { recursive: true, mode: 0o700 });
    accountAuth = new AccountAuthCoordinator({
      statePath: join(home, "subscriptions", "account-auth.v1.json")
    });
    const activeCredentialFingerprints = (): Map<string, string> =>
      new Map(
        accountStoreEntries(env).flatMap((entry) =>
          entry.connector === "native"
            ? [
                [
                  subscriptionAccountIdentity(entry.subscriptionKind, entry.label),
                  subscriptionCredentialFingerprint(entry.path)
                ] as const
              ]
            : []
        )
      );
    const applyLeaderboardConfig = (config: RouterConfig): void => {
      leaderboardConfig = resolveLeaderboardConfig(config);
      callAttributions.configureBudget({
        limit: leaderboardConfig.liveLimit,
        ttlMs: leaderboardConfig.liveTtlHours * 60 * 60 * 1_000
      });
      leaderboardRollups.configure({
        durable: leaderboardConfig.durable,
        durableRetentionDays: leaderboardConfig.durableRetentionDays
      });
    };
    const provenance = {
      onModelCall(record: Parameters<typeof callInspection>[0]): void {
        callAttributions.onModelCall(record);
        const inspection = callInspection(record);
        if (inspection !== undefined) leaderboardRollups.record(inspection);
        gatewayTelemetry?.record(record);
      }
    };
    const wantsCliproxySidecar = (config: RouterConfig): boolean =>
      config.providers["cliproxy"] !== undefined;
    // Router generations reach the managed sidecar with its own ingress key
    // and configured listen address; resolved per generation so state created
    // by the first login (key, config) is seen without a daemon restart.
    const routerEnv = (): NodeJS.ProcessEnv => {
      const injected: NodeJS.ProcessEnv = { ...env };
      if ((env[CLIPROXY_API_KEY_ENV] ?? "").length === 0) {
        const key = cliproxyApiKey(env);
        if (key !== undefined) injected[CLIPROXY_API_KEY_ENV] = key;
      }
      if ((env[CLIPROXY_BASE_URL_ENV] ?? "").length === 0) {
        injected[CLIPROXY_BASE_URL_ENV] = cliproxyBaseUrl(env);
      }
      return injected;
    };
    const startGeneration = async (config: RouterConfig): Promise<RunningRouter> =>
      await startRouter({
        config,
        host: "127.0.0.1",
        port: 0,
        env: routerEnv(),
        provenance,
        activity: accountActivity!,
        authHealth: accountAuth!,
        drainGraceMs
      });
    await sidecar.reconcile(wantsCliproxySidecar(currentConfig));
    activeRouter = await startGeneration(currentConfig);
    accountAuth.reconcileActiveCredentials(activeCredentialFingerprints());
    proxy = await startSwitchingGatewayProxy({
      target: activeRouter.url,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 8080,
      authToken: dataAuth.token,
      resolveDataPrincipal: (presented) => {
        const principal = tokens.resolve(presented, "data");
        if (principal === undefined) return undefined;
        return {
          id: principal.id,
          label: principal.label,
          role: principal.role
        };
      }
    });
    portless =
      hosted === undefined
        ? await createPortlessSession(options.portless ?? env.ROUTEKIT_PORTLESS !== "0", {
            project: "routekit",
            ownerLabel: "routekit-daemon",
            bareNames: []
          })
        : undefined;
    const dataUrl =
      hosted?.dataUrl() ??
      (portless?.enabled === true ? portless.register("gateway", proxy.port()) : proxy.url());

    const replaceRouter = async (
      nextConfig: RouterConfig,
      nextDocument: string,
      input: {
        write: boolean;
        configRevision?: boolean;
        accountRevision?: boolean;
        beforeSwap?: () => void | Promise<void>;
      }
    ): Promise<void> => {
      // Sidecar reconcile runs before the generation commits; any failure
      // below must put the sidecar back to the still-live currentConfig.
      let candidate: RunningRouter;
      try {
        await sidecar.reconcile(wantsCliproxySidecar(nextConfig));
        candidate = await startGeneration(nextConfig);
      } catch (error) {
        try {
          await sidecar.reconcile(wantsCliproxySidecar(currentConfig));
        } catch {
          // Best-effort rollback; surface the original mutation failure.
        }
        throw error;
      }
      const previousDocument = currentDocument;
      const previousRevisions = { ...revisions };
      const nextRevisions = { ...revisions };
      if (input.configRevision === true) nextRevisions.config += 1;
      if (input.accountRevision === true) nextRevisions.accounts += 1;
      try {
        if (input.write) writeRouterConfig(configPath, nextConfig);
        writeDaemonRevisions(home, nextRevisions);
        await input.beforeSwap?.();
      } catch (error) {
        if (input.write) {
          writeFileAtomic(configPath, previousDocument, { mode: 0o600 });
          chmodSync(configPath, 0o600);
        }
        revisions = previousRevisions;
        writeDaemonRevisions(home, previousRevisions);
        await candidate.close();
        await sidecar.reconcile(wantsCliproxySidecar(currentConfig));
        throw error;
      }
      const previousRouter = activeRouter;
      // From this point the mutation is committed. `swapTarget` is synchronous
      // and non-throwing; retirement failures must never close the candidate.
      const previousTarget = proxy?.swapTarget(candidate.url);
      activeRouter = candidate;
      currentConfig = nextConfig;
      currentDocument = input.write ? readFileSync(configPath, "utf8") : nextDocument;
      revisions = nextRevisions;
      applyLeaderboardConfig(currentConfig);
      accountAuth?.reconcileActiveCredentials(activeCredentialFingerprints());
      if (previousRouter !== undefined) {
        try {
          if (previousTarget !== undefined) {
            await proxy?.waitForTargetIdle(previousTarget, drainGraceMs);
          }
          await previousRouter.gateway.drain(drainGraceMs);
          await previousRouter.close();
        } catch (error) {
          process.stderr.write(
            `routekit retired router cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`
          );
        }
      }
    };

    const configSnapshot = (): ConfigSnapshot => ({
      path: configPath,
      document: currentDocument,
      revision: revisions.config,
      sources: ["global"]
    });

    let handlers: RouteKitControlHandlers;
    const telemetryStatus = (): import("@velum-labs/routekit-telemetry-core").TelemetryStatus =>
      telemetryStatusMetadata(telemetry.resolve(env), {
        provider: "posthog",
        host: env.ROUTEKIT_POSTHOG_HOST?.trim() || DEFAULT_TELEMETRY_HOST,
        configured: resolveTelemetryProjectKey(env).length > 0
      }) as import("@velum-labs/routekit-telemetry-core").TelemetryStatus;
    handlers = {
      "daemon.status": async () =>
        ({
          pid: process.pid,
          workerPid: process.pid,
          hostPid: hosted?.hostPid ?? process.pid,
          hostStartedAt: hosted?.hostStartedAt ?? startedAt,
          startedAt,
          packageVersion: options.packageVersion,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          hostProtocolVersion: hosted === undefined ? 0 : DAEMON_HOST_PROTOCOL_VERSION,
          generation,
          configRevision: revisions.config,
          accountRevision: revisions.accounts,
          controlUrl: control?.url ?? "",
          dataUrl: hosted?.dataUrl() ?? dataUrl,
          dataPort: proxy?.port() ?? 0,
          supervisor: supervisorFromEnv(env),
          draining,
          rolling: hosted?.rolling() ?? false
        }) satisfies DaemonStatus,
      "daemon.reload": async (params) => {
        await serializeMutation(async () => {
          if (
            params.expectedRevision !== undefined &&
            params.expectedRevision !== revisions.config
          ) {
            revisionConflict(params.expectedRevision, revisions.config);
          }
          const document = canonicalConfigDocument(configPath);
          await replaceRouter(parseConfigDocument(document), document, {
            write: false,
            configRevision: true
          });
        });
        return {
          reloaded: true,
          configRevision: revisions.config,
          accountRevision: revisions.accounts
        };
      },
      "daemon.roll": async (params, context) => {
        if (context.principal?.role !== "ephemeral") {
          throw new ControlError({
            code: "unauthorized",
            message: "daemon roll requires the local service credential"
          });
        }
        if (options.onRollRequested === undefined) {
          throw new ControlError({
            code: "upgrade_required",
            message: "this daemon does not support rolling process replacement"
          });
        }
        const startedAt = Date.now();
        const supervisor = (["systemd", "launchd", "detached"] as const).includes(
          supervisorFromEnv(env) as never
        )
          ? (supervisorFromEnv(env) as "systemd" | "launchd" | "detached")
          : "unknown";
        const toVersion = params.candidate?.expectedVersion ?? options.packageVersion;
        daemonTelemetry?.capture("routekit.daemon_lifecycle", {
          action: "roll_started",
          outcome: "success",
          supervisor,
          version: options.packageVersion,
          reason: params.reason,
          from_version: options.packageVersion,
          to_version: toVersion
        });
        try {
          const result = await options.onRollRequested(params);
          daemonTelemetry?.capture("routekit.daemon_lifecycle", {
            action: "roll_committed",
            outcome: "success",
            supervisor,
            version: result.packageVersion,
            reason: params.reason,
            from_version: options.packageVersion,
            to_version: result.packageVersion,
            duration_bucket: durationBucket(Date.now() - startedAt)
          });
          return result;
        } catch (error) {
          daemonTelemetry?.capture("routekit.daemon_lifecycle", {
            action: "roll_failed",
            outcome: "error",
            supervisor,
            version: options.packageVersion,
            reason: params.reason,
            from_version: options.packageVersion,
            to_version: toVersion,
            rollback_stage: "candidate",
            duration_bucket: durationBucket(Date.now() - startedAt)
          });
          throw error;
        }
      },
      "daemon.prepareShutdown": async (params) => {
        if (lifecycle === "quiescing" || lifecycle === "draining" || lifecycle === "closed") {
          return { accepted: true };
        }
        lifecycle = "quiescing";
        draining = true;
        await mutationTail;
        queueMicrotask(() => options.onShutdownRequested?.(params.reason));
        return { accepted: true };
      },
      "config.get": async () => configSnapshot(),
      "config.update": async (params) => {
        await serializeMutation(async () => {
          if (params.expectedRevision !== revisions.config) {
            revisionConflict(params.expectedRevision, revisions.config);
          }
          const next = parseConfigDocument(params.document);
          await replaceRouter(next, params.document, {
            write: true,
            configRevision: true
          });
        });
        return configSnapshot();
      },
      "config.import": async (params) => {
        await serializeMutation(async () => {
          if (params.expectedRevision !== revisions.config) {
            revisionConflict(params.expectedRevision, revisions.config);
          }
          const next = parseConfigDocument(params.document);
          await replaceRouter(next, params.document, {
            write: true,
            configRevision: true
          });
        });
        return configSnapshot();
      },
      "providers.status": async (_params, context) => {
        const accounts = accountEntries(env);
        const live = await activeRouter!.providerStatuses(context.signal);
        const result = {
          providers: configuredProviderIds(currentConfig).map((provider) => {
            const status = live.find((entry) => entry.provider === provider);
            return {
              provider,
              configured: true,
              credentialAvailable: providerCredentialAvailable(provider, accounts, env),
              models: status?.models ?? [],
              ...(status?.error !== undefined ? { error: status.error } : {})
            };
          })
        };
        writeSnapshot(home, "health", "providers", {
          checkedAt: new Date().toISOString(),
          providers: result.providers
        });
        return result;
      },
      "providers.set": async (params) => {
        await serializeMutation(async () => {
          const raw = parseYaml(currentDocument) as Record<string, unknown>;
          const providers =
            typeof raw.providers === "object" &&
            raw.providers !== null &&
            !Array.isArray(raw.providers)
              ? { ...(raw.providers as Record<string, unknown>) }
              : {};
          if (params.enabled) providers[params.provider] ??= {};
          else delete providers[params.provider];
          raw.providers = providers;
          const document = stringifyYaml(raw);
          await replaceRouter(parseConfigDocument(document), document, {
            write: true,
            configRevision: true
          });
        });
        return configSnapshot();
      },
      "models.list": async (params) => {
        // Self-call over the loopback listener: the public dataUrl may be a
        // portless HTTPS route whose local CA Node does not trust.
        const response = await fetch(`${proxy!.url()}/v1/models`, {
          headers: { authorization: `Bearer ${dataAuth.token}` }
        });
        if (!response.ok) {
          throw new ControlError({
            code: "unavailable",
            message: `gateway model discovery failed (${response.status})`
          });
        }
        const body = (await response.json()) as {
          data?: ModelInfo[];
          default_model?: unknown;
        };
        const models = (body.data ?? []).filter(
          (model) => params.provider === undefined || model.id.startsWith(`${params.provider}/`)
        );
        const result = {
          models,
          ...(currentConfig.defaultModel !== undefined
            ? { defaultModel: currentConfig.defaultModel }
            : typeof body.default_model === "string" &&
                models.some((model) => model.id === body.default_model)
              ? { defaultModel: body.default_model }
            : {}),
          revision: revisions.config
        };
        writeSnapshot(home, "catalog", "models", {
          updatedAt: new Date().toISOString(),
          defaultModel: result.defaultModel,
          models
        });
        return result;
      },
      "models.info": async (params) => {
        const model = activeRouter!.modelInfo(params.model);
        if (model === undefined) {
          throw new ControlError({
            code: "not_found",
            message: `unknown model: ${params.model}`
          });
        }
        return {
          ...model,
          capabilities: { ...model.capabilities },
          reasoning: model.reasoning === null ? null : { ...model.reasoning }
        };
      },
      "calls.inspect": async (params) => {
        const inspection = callAttributions.get(params.callId);
        if (inspection === undefined) {
          throw new ControlError({
            code: "not_found",
            message: `unknown or expired model call: ${params.callId}`
          });
        }
        return inspection;
      },
      "calls.leaderboard": async (params) => {
        const by = params.by ?? "principal";
        const sort = params.sort ?? "cost";
        const limit = params.limit ?? 20;
        const window = params.window ?? defaultLeaderboardWindow(leaderboardConfig);
        const nowIso = new Date().toISOString();
        if (window === "live") {
          const inspections = callAttributions.list();
          const aggregated = aggregateInspections(inspections, { by, sort, limit });
          return buildLeaderboardResult({
            by,
            sort,
            source: "live",
            windowStart: aggregated.windowStart ?? nowIso,
            windowEnd: aggregated.windowEnd ?? nowIso,
            sampleSize: aggregated.sampleSize,
            truncated: callAttributions.truncated(),
            budget: leaderboardConfig,
            rows: aggregated.rows
          });
        }
        if (!leaderboardConfig.durable) {
          throw new ControlError({
            code: "bad_request",
            message:
              "durable leaderboard rollups are disabled; set leaderboard.durable: true in router.yaml"
          });
        }
        const aggregated = leaderboardRollups.query({ by, sort, limit, window });
        return buildLeaderboardResult({
          by,
          sort,
          source: "durable",
          windowStart: aggregated.windowStart,
          windowEnd: aggregated.windowEnd,
          sampleSize: aggregated.sampleSize,
          truncated: false,
          budget: leaderboardConfig,
          rows: aggregated.rows
        });
      },
      "accounts.list": async () => ({
        accounts: accountEntries(env).map((entry) => {
          if (entry.connector === "native") return entry;
          const { credentialValid: _credentialValid, ...listed } = entry;
          return listed;
        }),
        revision: revisions.accounts
      }),
      "accounts.status": async () => {
        const entries = accountEntries(env);
        const cliproxyConfigured = currentConfig.providers["cliproxy"] !== undefined;
        const cliproxyReachable =
          entries.some((entry) => entry.connector === "cliproxy") && cliproxyConfigured
            ? await sidecar.reachable()
            : false;
        return {
          accounts: entries.map((entry) => {
            if (entry.connector === "cliproxy") {
              const ready = entry.credentialValid && cliproxyConfigured && cliproxyReachable;
              return {
                subscriptionKind: entry.subscriptionKind,
                label: entry.label,
                connector: entry.connector,
                ...(entry.localOnly === true ? { localOnly: true } : {}),
                credentialValid: entry.credentialValid,
                configured: cliproxyConfigured,
                relayOpen: ready,
                serving: false,
                inFlight: 0,
                lastSelected: false,
                active: false,
                ...(entry.credentialValid
                  ? {}
                  : { readinessReasons: [{ code: "credential_invalid" as const }] }),
                models: []
              };
            }
            const member = activeRouter!
              .accountSnapshots()
              .find((snapshot) => snapshot.mode === entry.subscriptionKind)
              ?.members.find((candidate) => candidate.label === entry.label);
            return {
              subscriptionKind: entry.subscriptionKind,
              label: entry.label,
              connector: entry.connector,
              credentialValid: member?.credentialValid ?? false,
              ...(member?.upstreamAuthState !== undefined
                ? { upstreamAuthState: member.upstreamAuthState }
                : {}),
              configured: currentConfig.providers[entry.subscriptionKind] !== undefined,
              relayOpen:
                member?.relayReady === true &&
                currentConfig.providers[entry.subscriptionKind] !== undefined,
              serving: member?.serving ?? false,
              inFlight: member?.inFlight ?? 0,
              ...(member?.lastSelectedAt !== undefined
                ? { lastSelectedAt: member.lastSelectedAt }
                : {}),
              lastSelected: member?.lastSelected ?? false,
              active: member?.lastSelected ?? false,
              ...(member?.readinessReasons !== undefined
                ? { readinessReasons: member.readinessReasons }
                : member === undefined
                  ? { readinessReasons: [{ code: "credential_invalid" as const }] }
                  : {}),
              models: member?.models ?? [],
              ...(member?.limits !== undefined ? { limits: member.limits } : {})
            };
          }),
          revision: revisions.accounts,
          recovery: {
            state: accountRecovery.recovered > 0 ? "recovered" : "clean",
            recovered: accountRecovery.recovered,
            cleaned: accountRecovery.cleaned
          }
        };
      },
      "accounts.enroll": async (params) => {
        await serializeMutation(async () => {
          const label = sanitizeSubscriptionLabel(params.label);
          if (label !== params.label || label.startsWith(".")) {
            throw new ControlError({
              code: "bad_request",
              message: "account label must already be normalized"
            });
          }
          const directory = defaultSubscriptionAccountDirectory(params.kind, env);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, `${label}.json`);
          if (existsSync(path)) {
            throw new ControlError({
              code: "conflict",
              message: `${params.kind}/${label} is already enrolled; remove it before enrolling again`
            });
          }
          const previous = existsSync(path) ? readFileSync(path) : undefined;
          writeFileAtomic(
            path,
            `${JSON.stringify(safeCredentialBlob(params.kind, params.credential), null, 2)}\n`,
            { mode: 0o600 }
          );
          chmodSync(path, 0o600);
          try {
            await replaceRouter(currentConfig, currentDocument, {
              write: false,
              accountRevision: true
            });
          } catch (error) {
            if (previous === undefined) rmSync(path, { force: true });
            else {
              writeFileAtomic(path, previous.toString("utf8"), { mode: 0o600 });
              chmodSync(path, 0o600);
            }
            throw error;
          }
        });
        return { enrolled: true, revision: revisions.accounts };
      },
      "accounts.enrollActivate": async (params) => {
        const resolved = resolveAccountConnector(params.kind);
        if (resolved === undefined) {
          throw new ControlError({
            code: "bad_request",
            message: `unknown subscription kind: ${params.kind}`
          });
        }
        const kind = resolved.kind;
        const connector = resolved.info.connector;
        const provider = connector === "cliproxy" ? "cliproxy" : kind;
        const seenLabels = new Set<string>();
        const prepared = params.accounts.map((account) => {
          const label =
            connector === "native"
              ? sanitizeSubscriptionLabel(account.label)
              : safeCliproxyLabel(account.label);
          if (label !== account.label || (connector === "native" && label.startsWith("."))) {
            throw new ControlError({
              code: "bad_request",
              message: "account label must already be normalized"
            });
          }
          if (seenLabels.has(label)) {
            throw new ControlError({
              code: "bad_request",
              message: `duplicate account label: ${label}`
            });
          }
          seenLabels.add(label);
          const directory =
            connector === "native"
              ? defaultSubscriptionAccountDirectory(kind as SubscriptionMode, env)
              : cliproxyAuthDirectory(env);
          const path = join(directory, `${label}.json`);
          let credential = account.credential;
          if (credential === undefined) {
            if (!existsSync(path)) {
              throw new ControlError({
                code: "not_found",
                message: `${kind}/${label} is not enrolled`
              });
            }
            try {
              credential = JSON.parse(readFileSync(path, "utf8")) as unknown;
            } catch {
              throw new ControlError({
                code: "bad_request",
                message: `${kind}/${label} has an invalid stored credential`
              });
            }
          }
          const blob =
            connector === "native"
              ? safeCredentialBlob(kind as SubscriptionMode, credential)
              : safeCliproxyCredentialBlob(kind, credential);
          const content = `${JSON.stringify(blob, null, 2)}\n`;
          if (
            connector === "native" &&
            account.credential !== undefined &&
            existsSync(path) &&
            readFileSync(path, "utf8") !== content
          ) {
            throw new ControlError({
              code: "conflict",
              message: `${kind}/${label} is already enrolled with different credentials`
            });
          }
          return {
            label,
            directory,
            path,
            content,
            credentialProvided: account.credential !== undefined
          };
        });
        await serializeMutation(async () => {
          for (const entry of prepared) {
            if (!entry.credentialProvided) {
              if (!existsSync(entry.path)) {
                throw new ControlError({
                  code: "not_found",
                  message: `${kind}/${entry.label} is not enrolled`
                });
              }
              let stored: unknown;
              try {
                stored = JSON.parse(readFileSync(entry.path, "utf8")) as unknown;
              } catch {
                throw new ControlError({
                  code: "bad_request",
                  message: `${kind}/${entry.label} has an invalid stored credential`
                });
              }
              const blob =
                connector === "native"
                  ? safeCredentialBlob(kind as SubscriptionMode, stored)
                  : safeCliproxyCredentialBlob(kind, stored);
              entry.content = `${JSON.stringify(blob, null, 2)}\n`;
            } else if (
              connector === "native" &&
              existsSync(entry.path) &&
              readFileSync(entry.path, "utf8") !== entry.content
            ) {
              throw new ControlError({
                code: "conflict",
                message: `${kind}/${entry.label} is already enrolled with different credentials`
              });
            }
          }
          const unchanged = prepared.every(
            (entry) => existsSync(entry.path) && readFileSync(entry.path, "utf8") === entry.content
          );
          if (
            unchanged &&
            (currentConfig.providers as Record<string, unknown>)[provider] !== undefined
          ) {
            return;
          }

          const raw = parseYaml(currentDocument) as Record<string, unknown>;
          const providers =
            typeof raw.providers === "object" &&
            raw.providers !== null &&
            !Array.isArray(raw.providers)
              ? { ...(raw.providers as Record<string, unknown>) }
              : {};
          providers[provider] ??= {};
          raw.providers = providers;
          const nextDocument = stringifyYaml(raw);
          const nextConfig = parseConfigDocument(nextDocument);
          const previousDocument = currentDocument;
          const previousConfig = currentConfig;
          const transaction = prepareAccountTransaction({
            home,
            configPath,
            accountPaths: [
              ...prepared.map((entry) => entry.path),
              ...(connector === "native"
                ? [join(home, "subscriptions", "account-auth.v1.json")]
                : [])
            ],
            accountRoots: [
              ...prepared.map((entry) => entry.directory),
              ...(connector === "native" ? [join(home, "subscriptions")] : [])
            ],
            kind,
            provider,
            labels: prepared.map((entry) => entry.label)
          });
          options.onAccountTransactionPhase?.("prepared");
          let routerReplaced = false;
          try {
            for (const entry of prepared) {
              mkdirSync(entry.directory, { recursive: true, mode: 0o700 });
              chmodSync(entry.directory, 0o700);
              writeFileAtomic(entry.path, entry.content, { mode: 0o600 });
              chmodSync(entry.path, 0o600);
            }
            options.onAccountTransactionPhase?.("credentials-written");
            await replaceRouter(nextConfig, nextDocument, {
              write: true,
              configRevision: true,
              accountRevision: true,
              beforeSwap: async () => {
                if (connector === "native") {
                  for (const entry of prepared) {
                    accountAuth!.activateFingerprint(
                      subscriptionAccountIdentity(kind as SubscriptionMode, entry.label),
                      subscriptionCredentialFingerprint(entry.path)
                    );
                  }
                }
                markAccountTransactionCommitted(transaction);
                if (connector === "cliproxy") await sidecar.refresh();
                options.onAccountTransactionPhase?.("committed");
              }
            });
            routerReplaced = true;
            options.onAccountTransactionPhase?.("router-swapped");
            try {
              cleanupAccountTransaction(transaction);
            } catch {
              // A committed manifest is cleanup-only on the next daemon start.
            }
          } catch (error) {
            const rollbackFailures: unknown[] = [];
            try {
              rollbackAccountTransaction(transaction, home);
              accountAuth?.reload();
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
            if (connector === "cliproxy") {
              try {
                await sidecar.refresh();
              } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
              }
            }
            if (routerReplaced) {
              try {
                await replaceRouter(previousConfig, previousDocument, {
                  write: false
                });
              } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
              }
            }
            if (rollbackFailures.length > 0) {
              throw new AggregateError(
                [error, ...rollbackFailures],
                `could not activate ${kind}; rollback failed`
              );
            }
            throw error;
          }
        });
        return {
          enrolled: prepared.map((entry) => ({
            subscriptionKind: kind,
            label: entry.label
          })),
          activated: true,
          configPath,
          configRevision: revisions.config,
          accountRevision: revisions.accounts
        };
      },
      "accounts.remove": async (params) => {
        const resolved = resolveAccountConnector(params.kind);
        const rawCliproxyEntry =
          resolved === undefined
            ? cliproxyAccountEntries(env).find(
                (entry) => entry.kind === params.kind && entry.label === params.label
              )
            : undefined;
        if (resolved === undefined && rawCliproxyEntry === undefined) {
          throw new ControlError({
            code: "bad_request",
            message: `unknown subscription kind: ${params.kind}`
          });
        }
        const kind = resolved?.kind ?? params.kind;
        let removed = false;
        await serializeMutation(async () => {
          // Prefer the native account store when both connectors have a file
          // for the same label (claude-code/codex). Fall back to the cliproxy
          // store so legacy orphan auth files (type: claude|codex) and the
          // gemini/grok/kimi kinds remain removable through one surface.
          const nativeDirectory =
            resolved?.info.connector === "native"
              ? defaultSubscriptionAccountDirectory(kind as SubscriptionMode, env)
              : undefined;
          const nativePath =
            nativeDirectory !== undefined
              ? join(nativeDirectory, `${params.label}.json`)
              : undefined;
          if (nativePath !== undefined && existsSync(nativePath)) {
            const nativeKind = kind as SubscriptionMode;
            const activeNativeDirectory = dirname(nativePath);
            const hasRemainingAccount = accountEntries(env).some(
              (entry) =>
                entry.connector === "native" &&
                entry.subscriptionKind === nativeKind &&
                entry.label !== params.label
            );
            const raw = parseYaml(currentDocument) as Record<string, unknown>;
            const providers =
              typeof raw.providers === "object" &&
              raw.providers !== null &&
              !Array.isArray(raw.providers)
                ? { ...(raw.providers as Record<string, unknown>) }
                : {};
            const disableProvider =
              !hasRemainingAccount && currentConfig.providers[nativeKind] !== undefined;
            if (disableProvider) {
              for (const providerKey of nativeKind === "claude-code"
                ? ["claude-code", "claudeCode", "claude"]
                : [nativeKind]) {
                delete providers[providerKey];
              }
              raw.providers = providers;
              if (
                typeof raw.defaultModel === "string" &&
                raw.defaultModel.startsWith(`${nativeKind}/`)
              ) {
                delete raw.defaultModel;
              }
            }
            const nextDocument = disableProvider ? stringifyYaml(raw) : currentDocument;
            const nextConfig = disableProvider ? parseConfigDocument(nextDocument) : currentConfig;
            const activityPath = join(home, "usage", "account-activity.v1.json");
            const authPath = join(home, "subscriptions", "account-auth.v1.json");
            const transaction = prepareAccountTransaction({
              home,
              configPath,
              accountPaths: [nativePath, activityPath, authPath],
              accountRoots: [activeNativeDirectory, home, join(home, "subscriptions")],
              kind: nativeKind,
              provider: nativeKind,
              labels: [params.label]
            });
            try {
              const result = removeSubscriptionAccount(nativeKind, params.label, {
                accountsDirectory: activeNativeDirectory
              });
              removed = result.removed;
              if (!result.removed) {
                cleanupAccountTransaction(transaction);
                return;
              }
              await replaceRouter(nextConfig, nextDocument, {
                write: disableProvider,
                configRevision: disableProvider,
                accountRevision: true,
                beforeSwap: () => {
                  accountActivity!.remove(subscriptionAccountIdentity(nativeKind, params.label));
                  accountAuth!.remove(subscriptionAccountIdentity(nativeKind, params.label));
                  markAccountTransactionCommitted(transaction);
                }
              });
              try {
                cleanupAccountTransaction(transaction);
              } catch {
                // A committed manifest is cleanup-only on the next daemon start.
              }
            } catch (error) {
              const rollbackFailures: unknown[] = [];
              try {
                rollbackAccountTransaction(transaction, home);
                accountActivity?.reload();
                accountAuth?.reload();
              } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
              }
              if (rollbackFailures.length > 0) {
                throw new AggregateError(
                  [error, ...rollbackFailures],
                  `could not remove ${kind}/${params.label}; rollback failed`
                );
              }
              throw error;
            }
            return;
          }
          const entry = cliproxyAccountEntries(env).find(
            (candidate) =>
              candidate.label === params.label &&
              (resolved === undefined
                ? candidate.kind === kind
                : cliproxyAccountMatchesKind(candidate, kind))
          );
          if (entry === undefined) return;
          const previous = readFileSync(entry.path);
          const result = removeCliproxyAccount(params.label, env);
          removed = result.removed;
          if (!result.removed) return;
          try {
            await sidecar.refresh();
            await replaceRouter(currentConfig, currentDocument, {
              write: false,
              accountRevision: true
            });
          } catch (error) {
            writeFileAtomic(entry.path, previous.toString("utf8"), { mode: 0o600 });
            chmodSync(entry.path, 0o600);
            try {
              await sidecar.refresh();
            } catch {
              // Best-effort process rollback; preserve the mutation failure.
            }
            throw error;
          }
        });
        return { removed, revision: revisions.accounts };
      },
      "accounts.rename": async (params) => {
        const resolved = resolveAccountConnector(params.kind);
        if (resolved === undefined || resolved.info.connector !== "native") {
          throw new ControlError({
            code: "bad_request",
            message: "account rename supports only claude-code and codex"
          });
        }
        const kind = resolved.kind as SubscriptionMode;
        for (const [field, label] of [
          ["source", params.source],
          ["target", params.target]
        ] as const) {
          if (sanitizeSubscriptionLabel(label) !== label || label.startsWith(".")) {
            throw new ControlError({
              code: "bad_request",
              message: `${field} account label must already be normalized`
            });
          }
        }
        await serializeMutation(async () => {
          const directory = defaultSubscriptionAccountDirectory(kind, env);
          const sourcePath = join(directory, `${params.source}.json`);
          const targetPath = join(directory, `${params.target}.json`);
          const trackerPath = join(directory, ".state.json");
          const activityPath = join(home, "usage", "account-activity.v1.json");
          const authPath = join(home, "subscriptions", "account-auth.v1.json");
          if (!existsSync(sourcePath)) {
            throw new ControlError({
              code: "not_found",
              message: `${kind}/${params.source} is not enrolled`
            });
          }
          try {
            lstatSync(targetPath);
            throw new ControlError({
              code: "conflict",
              message: `${kind}/${params.target} is already enrolled`
            });
          } catch (error) {
            if (
              error instanceof ControlError ||
              typeof error !== "object" ||
              error === null ||
              !("code" in error) ||
              error.code !== "ENOENT"
            ) {
              throw error;
            }
          }
          const transaction = prepareAccountTransaction({
            home,
            configPath,
            accountPaths: [sourcePath, targetPath, trackerPath, activityPath, authPath],
            accountRoots: [directory, home, join(home, "subscriptions")],
            kind,
            provider: kind,
            labels: [params.source, params.target]
          });
          try {
            renameSubscriptionAccount(kind, params.source, params.target, {
              accountsDirectory: directory
            });
            new RateLimitTracker(trackerPath, kind).renameMember(params.source, params.target);
            options.onAccountTransactionPhase?.("credentials-written");
            await replaceRouter(currentConfig, currentDocument, {
              write: false,
              accountRevision: true,
              beforeSwap: () => {
                accountActivity!.rename(
                  subscriptionAccountIdentity(kind, params.source),
                  subscriptionAccountIdentity(kind, params.target)
                );
                accountAuth!.rename(
                  subscriptionAccountIdentity(kind, params.source),
                  subscriptionAccountIdentity(kind, params.target)
                );
                markAccountTransactionCommitted(transaction);
              }
            });
            try {
              cleanupAccountTransaction(transaction);
            } catch {
              // A committed manifest is cleanup-only on the next daemon start.
            }
          } catch (error) {
            const rollbackFailures: unknown[] = [];
            try {
              rollbackAccountTransaction(transaction, home);
              accountActivity?.reload();
              accountAuth?.reload();
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
            if (rollbackFailures.length > 0) {
              throw new AggregateError(
                [error, ...rollbackFailures],
                `could not rename ${kind}/${params.source}; rollback failed`
              );
            }
            throw error;
          }
        });
        return { renamed: true, revision: revisions.accounts };
      },
      "accounts.sync": async () => {
        // A connector login wrote new account state outside the control
        // channel (the cliproxy auth store); rebuild the router generation and
        // reconcile the managed sidecar against the rescanned stores.
        await serializeMutation(async () => {
          await sidecar.refresh();
          await replaceRouter(currentConfig, currentDocument, {
            write: false,
            accountRevision: true
          });
        });
        return { synced: true, revision: revisions.accounts };
      },
      "accounts.usage": async (_params, context) => {
        return await activeRouter!.usage(context.signal);
      },
      "accounts.resetCredits": async (params, context) => {
        try {
          return {
            kind: params.kind,
            label: params.label,
            resetCredits: await activeRouter!.listResetCredits(
              params.kind,
              params.label,
              context.signal
            )
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("is not enrolled") || message.includes("no codex account pool")) {
            throw new ControlError({ code: "not_found", message });
          }
          throw error;
        }
      },
      "accounts.redeemReset": async (params, context) => {
        try {
          const result = await activeRouter!.redeemReset(
            {
              kind: params.kind,
              label: params.label,
              ...(params.creditId !== undefined ? { creditId: params.creditId } : {}),
              ...(params.redeemRequestId !== undefined
                ? { redeemRequestId: params.redeemRequestId }
                : {})
            },
            context.signal
          );
          return {
            ok: result.ok,
            code: result.code,
            kind: "codex" as const,
            label: result.label,
            redeemRequestId: result.redeemRequestId,
            ...(result.creditId !== undefined ? { creditId: result.creditId } : {}),
            ...(result.windowsReset !== undefined ? { windowsReset: result.windowsReset } : {}),
            usage: result.usage
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("is not enrolled") || message.includes("no redeemable")) {
            throw new ControlError({ code: "not_found", message });
          }
          if (
            message.includes("does not support") ||
            message.includes("no codex account pool") ||
            message.includes("creditId must not be empty") ||
            message.includes("account label is required")
          ) {
            throw new ControlError({ code: "bad_request", message });
          }
          throw new ControlError({ code: "internal", message });
        }
      },
      "telemetry.get": async () => telemetryStatus(),
      "telemetry.set": async (params) => {
        await serializeMutation(async () => {
          if (params.enabled === false) {
            if (telemetry.resolve(env).enabled) {
              gatewayTelemetry?.flush();
              await daemonTelemetry?.flush();
              await daemonTelemetry?.shutdown();
            } else {
              await daemonTelemetry?.discard();
            }
            gatewayTelemetry?.discard();
          }
          if (params.enabled !== undefined) {
            if (params.enabled) telemetry.enable();
            else telemetry.disable();
          }
          if (params.category !== undefined && params.categoryEnabled !== undefined) {
            if (
              !params.categoryEnabled &&
              (params.category === "usage" || params.category === "reliability")
            ) {
              gatewayTelemetry?.discard(params.category);
            }
            telemetry.setCategory(params.category, params.categoryEnabled);
          }
          const result = telemetry.resolve(env);
          if (result.enabled && result.categories.adoption) {
            daemonTelemetry?.capture("routekit.telemetry_preference_changed", {
              action: params.enabled !== undefined ? "master" : "category",
              ...(params.category !== undefined ? { category: params.category } : {}),
              enabled: params.enabled ?? params.categoryEnabled!,
              source: result.source,
              version: options.packageVersion
            });
          }
        });
        return telemetryStatus();
      },
      "telemetry.resetIdentity": async () => {
        await serializeMutation(async () => {
          gatewayTelemetry?.flush();
          await daemonTelemetry?.flush();
          await daemonTelemetry?.shutdown();
          gatewayTelemetry?.discard();
          telemetry.resetIdentity(env);
          const result = telemetry.resolve(env);
          if (result.enabled && result.categories.adoption) {
            daemonTelemetry?.capture("routekit.telemetry_preference_changed", {
              action: "identity-reset",
              enabled: true,
              source: result.source,
              version: options.packageVersion
            });
          }
        });
        return telemetryStatus();
      },
      "telemetry.schema": async () => TELEMETRY_SCHEMA_INVENTORY,
      "telemetry.captureCommand": async (params) => ({
        accepted: daemonTelemetry?.capture("routekit.command_completed", params) ?? false
      }),
      "doctor.run": async (_params, context) => {
        const providers = await activeRouter!.providerStatuses(context.signal);
        const configuredProviders = configuredProviderIds(currentConfig);
        const accounts = accountEntries(env);
        const missingProviders = [
          ...new Set(
            accounts
              .filter((entry) => {
                const provider =
                  entry.connector === "cliproxy" ? "cliproxy" : entry.subscriptionKind;
                return currentConfig.providers[provider] === undefined;
              })
              .map((entry) => entry.subscriptionKind)
          )
        ];
        const providerOnly = ["claude-code", "codex", "cliproxy"].filter(
          (provider) =>
            (currentConfig.providers as Record<string, unknown>)[provider] !== undefined &&
            !accounts.some((entry) =>
              provider === "cliproxy"
                ? entry.connector === "cliproxy"
                : entry.subscriptionKind === provider
            )
        );
        const consistent = missingProviders.length === 0 && providerOnly.length === 0;
        return {
          checks: [
            { name: "canonical config", ok: existsSync(configPath), detail: configPath },
            { name: "control plane", ok: control !== undefined },
            { name: "model gateway", ok: proxy !== undefined, detail: dataUrl },
            {
              name: "provider configuration",
              ok: configuredProviders.length > 0,
              detail:
                configuredProviders.length > 0
                  ? `${configuredProviders.length} provider(s) configured`
                  : "no providers configured; run `routekit providers add <provider>`"
            },
            {
              name: "account activation recovery",
              ok: true,
              detail:
                accountRecovery.recovered > 0
                  ? `recovered ${accountRecovery.recovered} interrupted operation(s)`
                  : "clean"
            },
            {
              name: "account/provider consistency",
              ok: consistent,
              detail: consistent
                ? "consistent"
                : [
                    ...(missingProviders.length > 0
                      ? [`routing disabled: ${missingProviders.join(", ")}`]
                      : []),
                    ...(providerOnly.length > 0
                      ? [`credential missing: ${providerOnly.join(", ")}`]
                      : [])
                  ].join("; ")
            },
            ...(wantsCliproxySidecar(currentConfig)
              ? [
                  {
                    name: "cliproxy sidecar",
                    ok: await sidecar.reachable(),
                    detail: sidecar.managed()
                      ? sidecar.running()
                        ? "managed; running"
                        : "managed; not running"
                      : "external"
                  }
                ]
              : []),
            ...providers.map((provider) => ({
              name: `${provider.provider} live discovery`,
              ok: provider.ok,
              detail: provider.error ?? `${provider.models.length} model(s)`
            }))
          ]
        };
      },
      "launcher.prepare": async (params, context) => {
        const listed = await handlers["models.list"](
          {},
          {
            signal: context.signal,
            requestId: "internal"
          }
        );
        let model = params.model ?? listed.defaultModel ?? listed.models[0]?.id;
        let codexSelection;
        if (params.tool === "codex") {
          const candidates = listed.models.flatMap((entry) => {
            const info = activeRouter!.modelInfo(entry.id);
            if (info === undefined) return [];
            return [{
              id: info.id,
              nativeId: info.nativeModel,
              provider: info.provider,
              billingScope: info.billingMode,
              ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
              ...(info.providerPriority !== undefined
                ? { providerPriority: info.providerPriority }
                : {}),
              ...(info.metadata?.architecture !== undefined
                ? { architecture: info.metadata.architecture }
                : {}),
              ...(info.metadata?.supportedParameters !== undefined
                ? { supportedParameters: info.metadata.supportedParameters }
                : {}),
              ...(info.reasoning !== null ? { reasoning: info.reasoning } : {})
            }];
          });
          try {
            const selected = await resolveCodexStartupModel({
              models: candidates,
              ...(listed.defaultModel !== undefined
                ? { preferredModel: listed.defaultModel }
                : {}),
              ...(params.model !== undefined ? { requestedModel: params.model } : {}),
              signal: context.signal
            });
            model = selected.model;
            codexSelection = {
              compatibleModelIds: [...selected.compatibleModelIds],
              models: [...selected.models]
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ControlError({
              code: params.model !== undefined && message.startsWith("unknown model")
                ? "not_found"
                : "unavailable",
              message
            });
          }
        }
        if (model === undefined || !listed.models.some((entry) => entry.id === model)) {
          throw new ControlError({
            code: "not_found",
            message:
              params.model === undefined
                ? "no model is available"
                : `unknown model: ${params.model}`
          });
        }
        return {
          tool: params.tool,
          model,
          gatewayUrl: dataUrl,
          authToken: dataTokenForPrincipal(
            tokens,
            dataTokenCache,
            dataAuth.token,
            context.principal
          ),
          env: {},
          ...(codexSelection !== undefined ? { codexSelection } : {})
        };
      },
      "tokens.issue": async (params, context) => {
        try {
          const issued = tokens.issue({
            label: params.label,
            plane: params.plane,
            role: "admin",
            createdBy: params.createdBy ?? context.principal?.label ?? "control"
          });
          if (issued.plane === "data") {
            dataTokenCache.set(issued.label, issued.token);
          }
          return {
            id: issued.id,
            label: issued.label,
            plane: issued.plane,
            role: issued.role,
            token: issued.token,
            ...(issued.plane === "control"
              ? {
                  joinCredential: encodeJoinCredential({
                    publicRecordPath: daemonPublicRecordPath(home),
                    token: issued.token
                  })
                }
              : {})
          };
        } catch (error) {
          throw new ControlError({
            code: "bad_request",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      },
      "tokens.list": async (params) => ({
        tokens: tokens.list(params.plane)
      }),
      "tokens.revoke": async (params) => {
        try {
          const revoked = tokens.revoke(params.id);
          if (revoked.plane === "data") dataTokenCache.delete(revoked.label);
          return revoked;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ControlError({
            code: message.startsWith("unknown token") ? "not_found" : "bad_request",
            message
          });
        }
      }
    };

    const operationFor = (
      method: RouteKitControlMethod,
      params: unknown
    ):
      | TelemetryEventProperties["routekit.product_operation_completed"]["operation"]
      | undefined => {
      switch (method) {
        case "daemon.reload":
          return "config_reload";
        case "config.update":
          return "config_update";
        case "config.import":
          return "config_import";
        case "providers.set":
          return (params as { enabled?: boolean }).enabled === true
            ? "provider_enable"
            : "provider_disable";
        case "accounts.enroll":
          return "account_enroll";
        case "accounts.enrollActivate":
          return "account_enroll_activate";
        case "accounts.remove":
          return "account_remove";
        case "accounts.sync":
          return "account_sync";
        case "launcher.prepare":
          return "launcher_prepare";
        case "tokens.issue":
          return "token_issue";
        case "tokens.revoke":
          return "token_revoke";
        default:
          return undefined;
      }
    };
    const captureOperation = (
      method: RouteKitControlMethod,
      params: unknown,
      outcome: "success" | "error",
      durationMs: number
    ): void => {
      const operation = operationFor(method, params);
      if (operation === undefined) return;
      daemonTelemetry?.capture("routekit.product_operation_completed", {
        operation,
        outcome,
        duration_bucket: durationBucket(durationMs),
        version: options.packageVersion
      });
    };
    const routeKitDispatch = createRouteKitControlHandler(handlers, {
      onCommitted: (method, params, durationMs) =>
        captureOperation(method, params, "success", durationMs),
      onControlError: (method, params, _code, durationMs) =>
        captureOperation(method, params, "error", durationMs)
    });
    const dispatch: import("@velum-labs/routekit-runtime").ControlHandler = async (
      method,
      params,
      context
    ) => {
      if (lifecycle === "paused" && MUTATING_ROUTEKIT_METHODS.has(method as RouteKitControlMethod)) {
        throw new ControlError({
          code: "unavailable",
          message: "RouteKit daemon is synchronizing a replacement worker"
        });
      }
      return await routeKitDispatch(method, params, context);
    };
    control = await startControlServer({
      handler: dispatch,
      token: hosted?.controlToken ?? generateControlToken(),
      product: ROUTEKIT_PRODUCT,
      packageVersion: options.packageVersion,
      port: options.controlPort,
      capabilities: [
        ROUTEKIT_CONTROL_CAPABILITY,
        ...(hosted === undefined ? [] : [ROUTEKIT_DAEMON_ROLL_CAPABILITY])
      ],
      authorize: (presented) => {
        const principal = tokens.resolve(presented, "control");
        if (principal === undefined) return undefined;
        return {
          id: principal.id,
          label: principal.label,
          role: principal.role
        };
      },
      onError: (error, context) => {
        const operation = context.method ?? "control transport";
        console.error(`RouteKit ${operation} failed (request ${context.requestId}):`, error);
      }
    });
    const workerRecordInput = {
      kind: ROUTEKIT_DAEMON_KIND,
      pid: process.pid,
      ...(processIdentity(process.pid) !== undefined
        ? { processIdentity: processIdentity(process.pid) }
        : {}),
      url: control.url,
      port: control.port,
      startedAt,
      version: options.packageVersion,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      controlToken: control.token,
      dataUrl,
      dataPort: proxy.port(),
      host: options.host ?? "127.0.0.1",
      portless: portless?.enabled ?? false,
      drainGraceMs,
      authTokenFile: dataAuth.path,
      generation,
      supervisor: supervisorFromEnv(env),
      ...(process.argv[1] !== undefined ? { binPath: process.argv[1] } : {}),
      args: redactedProcessArgs(process.argv.slice(2)),
      cwd: process.cwd()
    } satisfies Omit<ServiceRecord, "product" | "owner">;
    record =
      hosted === undefined
        ? store.write(workerRecordInput)
        : { product: ROUTEKIT_PRODUCT, owner: ROUTEKIT_PRODUCT, ...workerRecordInput };
    if (hosted === undefined) {
      writeDaemonPublicRecord(home, {
        product: ROUTEKIT_PRODUCT,
        kind: ROUTEKIT_DAEMON_KIND,
        url: control.url,
        port: control.port,
        generation,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        dataUrl,
        dataPort: proxy.port(),
        startedAt
      });
    }
    daemonTelemetry.capture("routekit.daemon_lifecycle", {
      action: "started",
      outcome: "success",
      supervisor: (["systemd", "launchd", "detached"] as const).includes(
        supervisorFromEnv(env) as never
      )
        ? (supervisorFromEnv(env) as "systemd" | "launchd" | "detached")
        : "unknown",
      version: options.packageVersion
    });
    extendCleanupGrace(drainGraceMs + 10_000);
    let closeRun: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closeRun ??= (async () => {
        closed = true;
        if (lifecycle === "running") lifecycle = "quiescing";
        draining = true;
        await mutationTail;
        gatewayTelemetry?.close();
        daemonTelemetry?.capture("routekit.daemon_lifecycle", {
          action: "stopped",
          outcome: "success",
          supervisor: (["systemd", "launchd", "detached"] as const).includes(
            supervisorFromEnv(env) as never
          )
            ? (supervisorFromEnv(env) as "systemd" | "launchd" | "detached")
            : "unknown",
          version: options.packageVersion
        });
        await daemonTelemetry?.shutdown();
        lifecycle = "draining";
        await proxy?.drain(drainGraceMs);
        await activeRouter?.close();
        accountActivity?.close();
        accountAuth?.close();
        if (hosted === undefined) await sidecar.close();
        await control?.close();
        if (hosted === undefined) {
          if (portless?.enabled) portless.unregister("gateway");
          store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
          removeDaemonPublicRecord(home);
          authority?.release();
        }
        lifecycle = "closed";
      })();
      return closeRun;
    };
    registerCleanup(close);
    process.on("SIGHUP", () => {
      void Promise.resolve(
        handlers["daemon.reload"](
          {},
          {
            signal: new AbortController().signal,
            requestId: "sighup"
          }
        )
      ).catch((error: unknown) => {
        process.stderr.write(
          `routekit daemon reload failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      });
    });
    return {
      record,
      dataUrl,
      controlUrl: control.url,
      close,
      retire: async (graceMs = drainGraceMs) => {
        if (lifecycle === "closed" || lifecycle === "draining") return;
        lifecycle = "quiescing";
        draining = true;
        await mutationTail;
        lifecycle = "draining";
        await Promise.all([proxy?.retire(graceMs), control?.retire(Math.min(graceMs, 2_000))]);
        await activeRouter?.close();
        accountActivity?.close();
        accountAuth?.close();
        gatewayTelemetry?.close();
        await daemonTelemetry?.shutdown();
        lifecycle = "closed";
      },
      pauseMutations: async () => {
        if (lifecycle !== "running") {
          throw new ControlError({ code: "unavailable", message: "RouteKit daemon is not mutable" });
        }
        lifecycle = "paused";
        await mutationTail;
        return {
          configRevision: revisions.config,
          accountRevision: revisions.accounts,
          configHash: createHash("sha256").update(currentDocument).digest("hex")
        };
      },
      resumeMutations: () => {
        if (lifecycle === "paused") lifecycle = "running";
      },
      snapshot: () => ({
        configRevision: revisions.config,
        accountRevision: revisions.accounts,
        configHash: createHash("sha256").update(currentDocument).digest("hex")
      }),
      reload: async () => {
        await handlers["daemon.reload"](
          {},
          {
            signal: new AbortController().signal,
            requestId: "direct"
          }
        );
      }
    };
  } catch (error) {
    gatewayTelemetry?.close();
    await daemonTelemetry?.shutdown();
    await proxy?.close();
    await activeRouter?.close();
    accountActivity?.close();
    accountAuth?.close();
    if (hosted === undefined) await sidecarRef?.close();
    await control?.close();
    if (hosted === undefined) {
      if (portless?.enabled) portless.unregister("gateway");
      if (record !== undefined) store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
      removeDaemonPublicRecord(home);
      authority?.release();
    }
    throw error;
  }
}

export { ROUTEKIT_DAEMON_WORKER_ENV } from "./host-protocol.js";

export async function startRouteKitDaemonHost(
  options: RouteKitDaemonOptions & { entryPath: string }
): Promise<import("./host.js").RunningRouteKitDaemonHost> {
  const daemonHost = await import("./host.js");
  return await daemonHost.startRouteKitDaemonHost(options);
}

export async function runRouteKitDaemonWorker(options: RouteKitDaemonOptions): Promise<never> {
  const daemonWorker = await import("./worker.js");
  return await daemonWorker.runRouteKitDaemonWorker(options);
}
