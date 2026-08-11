import { chmodSync, readFileSync } from "node:fs";
import type {
  AccountActivityCoordinator,
  AccountAuthCoordinator
} from "@velum-labs/routekit-accounts";
import { writeRouterConfig } from "@velum-labs/routekit-config";
import type {
  ProvenanceSink,
  RouterConfig,
  SwitchingGatewayProxy
} from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { startRouter } from "@velum-labs/routekit-router";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import type { RevisionState } from "./daemon-state.js";
import { writeDaemonRevisions } from "./daemon-state.js";

export type DaemonGenerationStage = "prepare" | "validate" | "persist" | "commit" | "retire";

export type DaemonGenerationMutation = {
  write: boolean;
  configRevision?: boolean;
  accountRevision?: boolean;
  /** Complete all fallible domain writes before the live target is published. */
  persist?: () => void | Promise<void>;
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
  /** Must be synchronous and non-throwing: publication has already occurred. */
  onConfigCommitted(config: RouterConfig): void;
  onStage?: (stage: DaemonGenerationStage) => void;
};

export type DaemonGenerationManager = {
  start(config: RouterConfig): Promise<RunningRouter>;
  replace(
    nextConfig: RouterConfig,
    nextDocument: string,
    mutation: DaemonGenerationMutation
  ): Promise<void>;
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
    let candidate: RunningRouter | undefined;
    try {
      options.onStage?.("prepare");
      await options.sidecar.reconcile(options.wantsSidecar(nextConfig));
      candidate = await start(nextConfig);
      options.onStage?.("validate");
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      if (candidate !== undefined) {
        try {
          await candidate.close();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      try {
        await options.sidecar.reconcile(options.wantsSidecar(options.getCurrentConfig()));
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          "router generation preparation failed and rollback was incomplete"
        );
      }
      throw error;
    }

    const previousDocument = options.getCurrentDocument();
    const previousRevisions = { ...options.getRevisions() };
    const nextRevisions = { ...previousRevisions };
    if (mutation.configRevision === true) nextRevisions.config += 1;
    if (mutation.accountRevision === true) nextRevisions.accounts += 1;
    let committedDocument = nextDocument;
    try {
      options.onStage?.("persist");
      if (mutation.write) writeRouterConfig(options.configPath, nextConfig);
      writeDaemonRevisions(options.home, nextRevisions);
      await mutation.persist?.();
      committedDocument = mutation.write
        ? readFileSync(options.configPath, "utf8")
        : nextDocument;
      // This is the last fallible pre-publication stage. A failure here rolls
      // back persisted state and closes the unpublished candidate.
      options.onStage?.("commit");
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      try {
        if (mutation.write) {
          writeFileAtomic(options.configPath, previousDocument, { mode: 0o600 });
          chmodSync(options.configPath, 0o600);
        }
        options.setRevisions(previousRevisions);
        writeDaemonRevisions(options.home, previousRevisions);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      try {
        await candidate.close();
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      try {
        await options.sidecar.reconcile(options.wantsSidecar(options.getCurrentConfig()));
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          "router generation persistence failed and rollback was incomplete"
        );
      }
      throw error;
    }

    const previousRouter = options.getActiveRouter();
    const proxy = options.getProxy();

    // Atomic publication is the final fallible transaction boundary. Everything
    // after this point is assignment-only or best-effort retirement.
    const previousTarget = proxy?.swapTarget(candidate.url);
    options.setActiveRouter(candidate);
    options.setCurrentConfig(nextConfig);
    options.setCurrentDocument(committedDocument);
    options.setRevisions(nextRevisions);
    try {
      options.onConfigCommitted(nextConfig);
      options.authHealth.reconcileActiveCredentials(options.activeCredentialFingerprints());
    } catch (error) {
      process.stderr.write(
        `routekit post-commit observer failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    if (previousRouter === undefined) return;

    const retirementFailures: unknown[] = [];
    try {
      options.onStage?.("retire");
    } catch (error) {
      retirementFailures.push(error);
    }
    if (previousTarget !== undefined) {
      try {
        await proxy?.waitForTargetIdle(previousTarget, options.drainGraceMs);
      } catch (error) {
        retirementFailures.push(error);
      }
    }
    try {
      await previousRouter.gateway.drain(options.drainGraceMs);
    } catch (error) {
      retirementFailures.push(error);
    }
    try {
      await previousRouter.close();
    } catch (error) {
      retirementFailures.push(error);
    }
    if (retirementFailures.length > 0) {
      const error =
        retirementFailures.length === 1
          ? retirementFailures[0]
          : new AggregateError(retirementFailures, "retired router cleanup failed");
      process.stderr.write(
        `routekit retired router cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  };

  return { start, replace };
}
