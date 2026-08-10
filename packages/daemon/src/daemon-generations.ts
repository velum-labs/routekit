import { chmodSync, readFileSync } from "node:fs";
import type { AccountActivityCoordinator, AccountAuthCoordinator } from "@velum-labs/routekit-accounts";
import { writeRouterConfig } from "@velum-labs/routekit-config";
import type { RouterConfig, SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { ProvenanceSink } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { startRouter } from "@velum-labs/routekit-router";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";
import { writeDaemonRevisions } from "./daemon-state.js";
import type { RevisionState } from "./daemon-state.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";

export type DaemonGenerationMutation = {
  write: boolean;
  configRevision?: boolean;
  accountRevision?: boolean;
  beforeSwap?: () => void | Promise<void>;
};

export type DaemonGenerationManagerOptions = {
  configPath: string;
  home: string;
  drainGraceMs: number;
  sidecar: CliproxySidecar;
  routerEnv: () => NodeJS.ProcessEnv;
  provenance: ProvenanceSink;
  activity: AccountActivityCoordinator;
  authHealth: AccountAuthCoordinator;
  wantsSidecar(config: RouterConfig): boolean;
  getCurrentConfig(): RouterConfig;
  setCurrentConfig(config: RouterConfig): void;
  getCurrentDocument(): string;
  setCurrentDocument(document: string): void;
  getRevisions(): RevisionState;
  setRevisions(revisions: RevisionState): void;
  getActiveRouter(): RunningRouter | undefined;
  setActiveRouter(router: RunningRouter): void;
  getProxy(): SwitchingGatewayProxy | undefined;
  activeCredentialFingerprints(): Map<string, string>;
  onConfigCommitted(config: RouterConfig): void;
};

export type DaemonGenerationManager = {
  start(config: RouterConfig): Promise<RunningRouter>;
  replace(nextConfig: RouterConfig, nextDocument: string, mutation: DaemonGenerationMutation): Promise<void>;
};

export function createDaemonGenerationManager(
  options: DaemonGenerationManagerOptions
): DaemonGenerationManager {
  const start = async (config: RouterConfig): Promise<RunningRouter> =>
    await startRouter({
      config,
      host: "127.0.0.1",
      port: 0,
      env: options.routerEnv(),
      provenance: options.provenance,
      activity: options.activity,
      authHealth: options.authHealth,
      drainGraceMs: options.drainGraceMs
    });

  const replace = async (
    nextConfig: RouterConfig,
    nextDocument: string,
    mutation: DaemonGenerationMutation
  ): Promise<void> => {
    let candidate: RunningRouter;
    try {
      await options.sidecar.reconcile(options.wantsSidecar(nextConfig));
      candidate = await start(nextConfig);
    } catch (error) {
      try {
        await options.sidecar.reconcile(options.wantsSidecar(options.getCurrentConfig()));
      } catch {
        // Best-effort rollback; surface the original mutation failure.
      }
      throw error;
    }

    const previousDocument = options.getCurrentDocument();
    const previousRevisions = { ...options.getRevisions() };
    const nextRevisions = { ...previousRevisions };
    if (mutation.configRevision === true) nextRevisions.config += 1;
    if (mutation.accountRevision === true) nextRevisions.accounts += 1;
    try {
      if (mutation.write) writeRouterConfig(options.configPath, nextConfig);
      writeDaemonRevisions(options.home, nextRevisions);
      await mutation.beforeSwap?.();
    } catch (error) {
      if (mutation.write) {
        writeFileAtomic(options.configPath, previousDocument, { mode: 0o600 });
        chmodSync(options.configPath, 0o600);
      }
      options.setRevisions(previousRevisions);
      writeDaemonRevisions(options.home, previousRevisions);
      await candidate.close();
      await options.sidecar.reconcile(options.wantsSidecar(options.getCurrentConfig()));
      throw error;
    }

    const previousRouter = options.getActiveRouter();
    const proxy = options.getProxy();
    const previousTarget = proxy?.swapTarget(candidate.url);
    options.setActiveRouter(candidate);
    options.setCurrentConfig(nextConfig);
    options.setCurrentDocument(mutation.write ? readFileSync(options.configPath, "utf8") : nextDocument);
    options.setRevisions(nextRevisions);
    options.onConfigCommitted(nextConfig);
    options.authHealth.reconcileActiveCredentials(options.activeCredentialFingerprints());
    if (previousRouter === undefined) return;

    try {
      if (previousTarget !== undefined) await proxy?.waitForTargetIdle(previousTarget, options.drainGraceMs);
      await previousRouter.gateway.drain(options.drainGraceMs);
      await previousRouter.close();
    } catch (error) {
      process.stderr.write(
        `routekit retired router cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  };

  return { start, replace };
}
