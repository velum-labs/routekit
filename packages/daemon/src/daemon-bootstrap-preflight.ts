import { join } from "node:path";
import { globalRouterConfigPath, routekitHome } from "@velum-labs/routekit-config";
import {
  acquireLifecycleLock,
  ControlError,
  createServiceRecordStore,
  createTokenStore,
  type LifecycleLock,
  type ServiceRecordStore
} from "@velum-labs/routekit-runtime";
import type { AccountTransactionRecovery } from "./account-transaction.js";
import { recoverAccountTransactions } from "./account-transaction.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import type { RouteKitControlMethod, RouteKitControlParams } from "@velum-labs/routekit-control";
import {
  canonicalConfigDocument,
  dataTokenPath,
  parseConfigDocument
} from "./daemon-maintenance.js";
import { DaemonRuntimeState } from "./daemon-runtime-state.js";
import { healthyControl, readDaemonRevisions, resolveDataToken } from "./daemon-state.js";

export type DaemonBootstrapPreflight = {
  env: NodeJS.ProcessEnv;
  home: string;
  configPath: string;
  drainGraceMs: number;
  tokens: ReturnType<typeof createTokenStore>;
  dataTokenCache: Map<string, string>;
  dataAuth: { token: string; path: string };
  store: ServiceRecordStore;
  hosted: DaemonBootstrapOptions["hosted"];
  authority: LifecycleLock | undefined;
  accountRecovery: AccountTransactionRecovery;
  runtimeState: DaemonRuntimeState;
  startedAt: string;
};

/**
 * Resolve daemon paths, acquire the singleton authority, recover interrupted
 * account transactions, and construct mutable runtime state. Keeping this
 * preflight separate makes the composition root independent of persistence
 * and singleton-lock mechanics.
 */
export type DaemonBootstrapHostedOptions = {
  generation: number;
  controlToken: string;
  dataUrl: () => string;
  hostPid: number;
  hostStartedAt: string;
  rolling: () => boolean;
  sidecar: CliproxySidecar;
  initiallyPaused?: boolean;
  executeIdempotent?<T>(input: {
    method: RouteKitControlMethod;
    key: string;
    params: RouteKitControlParams[RouteKitControlMethod];
    operation(): Promise<T>;
  }): Promise<T>;
};

export type DaemonBootstrapOptions = {
  env?: NodeJS.ProcessEnv;
  stateHome?: string;
  configPath?: string;
  drainGraceMs?: number;
  authToken?: string;
  authTokenFile?: string;
  hosted?: DaemonBootstrapHostedOptions;
};

export async function prepareDaemonBootstrap(
  options: DaemonBootstrapOptions
): Promise<DaemonBootstrapPreflight> {
  const env = options.env ?? process.env;
  const home = options.stateHome ?? routekitHome(env);
  const configPath = options.configPath ?? globalRouterConfigPath();
  const drainGraceMs = options.drainGraceMs ?? 30_000;
  const tokens = createTokenStore(home);
  const dataTokenCache = new Map<string, string>();
  const dataAuth = resolveDataToken(home, options, tokens, dataTokenPath);
  dataTokenCache.set("default", dataAuth.token);
  const store = createServiceRecordStore({ home, product: "routekit" });
  const hosted = options.hosted;
  const authority =
    hosted === undefined
      ? await acquireLifecycleLock(join(store.directory, "daemon-authority.lock"), {
          timeoutMs: 30_000,
          onWait: async () => {
            const existing = store.read("daemon");
            return existing !== undefined && (await healthyControl(existing))
              ? new ControlError({
                  code: "conflict",
                  message: `RouteKit daemon is already running (pid ${existing.pid})`
                })
              : undefined;
          }
        })
      : undefined;

  let accountRecovery: AccountTransactionRecovery;
  try {
    accountRecovery = recoverAccountTransactions(home);
  } catch (error) {
    authority?.release();
    throw error;
  }

  return {
    env,
    home,
    configPath,
    drainGraceMs,
    tokens,
    dataTokenCache,
    dataAuth,
    store,
    hosted,
    authority,
    accountRecovery,
    runtimeState: new DaemonRuntimeState({
      config: parseConfigDocument(canonicalConfigDocument(configPath)),
      document: canonicalConfigDocument(configPath),
      revisions: readDaemonRevisions(home),
      initiallyPaused: hosted?.initiallyPaused
    }),
    startedAt: new Date().toISOString()
  };
}
