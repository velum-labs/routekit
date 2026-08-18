import { chmodSync, readFileSync } from "node:fs";
import type {
  AccountActivityService,
  AccountAuthService
} from "@velum-labs/routekit-accounts/effect";
import { type RouterConfig, writeRouterConfig } from "@velum-labs/routekit-config";
import type {
  CompositionalRoutingPolicyReader,
  ProvenanceSink,
  SwitchingGatewayProxy
} from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { startRouterEffect } from "@velum-labs/routekit-router/effect";
import { writeFileAtomic } from "@velum-labs/routekit-runtime/filesystem";
import {
  RouteKitFailure,
  type RouteKitPlatform,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import type { RevisionState } from "./daemon-state.js";
import { writeDaemonRevisions } from "./daemon-state.js";

export type DaemonGenerationStage = "prepare" | "validate" | "persist" | "commit" | "retire";

export type DaemonGenerationMutation = {
  write: boolean;
  configRevision?: boolean;
  accountRevision?: boolean;
  /** Complete all fallible domain writes before the live target is published. */
  persist?: () => Effect.Effect<void, Error, RouteKitPlatform>;
};

export type DaemonGenerationManagerOptions = {
  configPath: string;
  home: string;
  drainGraceMs: number;
  sidecar: CliproxySidecar;
  routerEnv: () => NodeJS.ProcessEnv;
  provenance: ProvenanceSink;
  /** Published model-by-dimension evidence used by automatic routing. */
  compositionalPolicyReader?: CompositionalRoutingPolicyReader;
  activity: AccountActivityService;
  authHealth: AccountAuthService;
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
  /** Apply daemon-local configuration before the proxy publishes the candidate. */
  applyConfig(config: RouterConfig): void;
  onStage?: (stage: DaemonGenerationStage) => void;
};

export type DaemonGenerationManager = {
  start(config: RouterConfig): Effect.Effect<RunningRouter, Error, RouteKitPlatform>;
  replace(
    nextConfig: RouterConfig,
    nextDocument: string,
    mutation: DaemonGenerationMutation
  ): Effect.Effect<void, Error, RouteKitPlatform>;
};

const tryPromise = <A>(run: () => Promise<A> | A): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: async () => await run(),
    catch: toRouteKitFailure
  });

const collectRollback = (
  work: Effect.Effect<unknown, unknown, RouteKitPlatform>
): Effect.Effect<unknown, never, RouteKitPlatform> =>
  work.pipe(
    Effect.as(undefined),
    Effect.catch((error) => Effect.succeed(error))
  );

export function createDaemonGenerationManager(
  options: DaemonGenerationManagerOptions
): DaemonGenerationManager {
  const start = (config: RouterConfig): Effect.Effect<RunningRouter, Error, RouteKitPlatform> =>
    startRouterEffect({
      config,
      host: "127.0.0.1",
      port: 0,
      env: options.routerEnv(),
      provenance: options.provenance,
      ...(options.compositionalPolicyReader !== undefined
        ? { compositionalPolicyReader: options.compositionalPolicyReader }
        : {}),
      activity: options.activity,
      authHealth: options.authHealth,
      drainGraceMs: options.drainGraceMs
    });

  const replace = (
    nextConfig: RouterConfig,
    nextDocument: string,
    mutation: DaemonGenerationMutation
  ): Effect.Effect<void, Error, RouteKitPlatform> =>
    Effect.scoped(
      Effect.gen(function* () {
        const proxy = options.getProxy();
        const previousRouter = options.getActiveRouter();
        if (proxy === undefined || previousRouter === undefined) {
          return yield* new RouteKitFailure({
            message: "router generation cannot replace before daemon publication"
          });
        }
        let candidate: RunningRouter | undefined;
        let published = false;
        yield* Effect.addFinalizer(() => {
          const unpublished = candidate;
          return !published && unpublished !== undefined
            ? unpublished.close.pipe(Effect.asVoid, Effect.ignore)
            : Effect.void;
        });
        yield* Effect.gen(function* () {
          yield* tryPromise(() => options.onStage?.("prepare"));
          yield* options.sidecar.reconcile(options.wantsSidecar(nextConfig));
          candidate = yield* start(nextConfig);
          yield* tryPromise(() => options.onStage?.("validate"));
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const rollbackFailures: unknown[] = [];
              if (candidate !== undefined) {
                const failure = yield* collectRollback(candidate!.close);
                if (failure !== undefined) rollbackFailures.push(failure);
              }
              const sidecarFailure = yield* collectRollback(
                options.sidecar.reconcile(options.wantsSidecar(options.getCurrentConfig()))
              );
              if (sidecarFailure !== undefined) rollbackFailures.push(sidecarFailure);
              if (rollbackFailures.length > 0) {
                return yield* Effect.fail(
                  new AggregateError(
                    [error, ...rollbackFailures],
                    "router generation preparation failed and rollback was incomplete"
                  )
                );
              }
              return yield* Effect.fail(error);
            })
          )
        );

        const previousDocument = options.getCurrentDocument();
        const previousConfig = options.getCurrentConfig();
        const previousRevisions = { ...options.getRevisions() };
        const nextRevisions = { ...previousRevisions };
        if (mutation.configRevision === true) nextRevisions.config += 1;
        if (mutation.accountRevision === true) nextRevisions.accounts += 1;
        let committedDocument = nextDocument;
        yield* Effect.gen(function* () {
          yield* tryPromise(() => {
            options.onStage?.("persist");
            if (mutation.write) writeRouterConfig(options.configPath, nextConfig);
            writeDaemonRevisions(options.home, nextRevisions);
          });
          if (mutation.persist !== undefined) yield* mutation.persist();
          committedDocument = mutation.write
            ? readFileSync(options.configPath, "utf8")
            : nextDocument;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const rollbackFailures: unknown[] = [];
              const persistFailure = yield* collectRollback(
                tryPromise(() => {
                  if (mutation.write) {
                    writeFileAtomic(options.configPath, previousDocument, { mode: 0o600 });
                    chmodSync(options.configPath, 0o600);
                  }
                  options.setRevisions(previousRevisions);
                  writeDaemonRevisions(options.home, previousRevisions);
                })
              );
              if (persistFailure !== undefined) rollbackFailures.push(persistFailure);
              const closeFailure = yield* collectRollback(candidate!.close);
              if (closeFailure !== undefined) rollbackFailures.push(closeFailure);
              const sidecarFailure = yield* collectRollback(
                options.sidecar.reconcile(options.wantsSidecar(options.getCurrentConfig()))
              );
              if (sidecarFailure !== undefined) rollbackFailures.push(sidecarFailure);
              if (rollbackFailures.length > 0) {
                return yield* Effect.fail(
                  new AggregateError(
                    [error, ...rollbackFailures],
                    "router generation persistence failed and rollback was incomplete"
                  )
                );
              }
              return yield* Effect.fail(error);
            })
          )
        );

        // Prepare every daemon-local view before publishing the new target. These
        // mutations are synchronous and are rolled back if the commit hook rejects.
        // swapTarget below is deliberately the final publication operation.
        yield* Effect.gen(function* () {
          options.setActiveRouter(candidate!);
          options.setCurrentConfig(nextConfig);
          options.setCurrentDocument(committedDocument);
          options.setRevisions(nextRevisions);
          options.applyConfig(nextConfig);
          yield* options.authHealth.reconcileActiveCredentials(
            options.activeCredentialFingerprints()
          );
          yield* tryPromise(() => options.onStage?.("commit"));
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const rollbackFailures: unknown[] = [];
              const viewFailure = yield* collectRollback(
                tryPromise(() => {
                  options.setActiveRouter(previousRouter);
                  options.setCurrentConfig(previousConfig);
                  options.setCurrentDocument(previousDocument);
                  options.setRevisions(previousRevisions);
                  options.applyConfig(previousConfig);
                })
              );
              if (viewFailure !== undefined) rollbackFailures.push(viewFailure);
              const persistFailure = yield* collectRollback(
                tryPromise(() => {
                  if (mutation.write) {
                    writeFileAtomic(options.configPath, previousDocument, { mode: 0o600 });
                    chmodSync(options.configPath, 0o600);
                  }
                  writeDaemonRevisions(options.home, previousRevisions);
                })
              );
              if (persistFailure !== undefined) rollbackFailures.push(persistFailure);
              const closeFailure = yield* collectRollback(candidate!.close);
              if (closeFailure !== undefined) rollbackFailures.push(closeFailure);
              const sidecarFailure = yield* collectRollback(
                options.sidecar.reconcile(options.wantsSidecar(previousConfig))
              );
              if (sidecarFailure !== undefined) rollbackFailures.push(sidecarFailure);
              if (rollbackFailures.length > 0) {
                return yield* Effect.fail(
                  new AggregateError(
                    [error, ...rollbackFailures],
                    "router generation commit preparation failed and rollback was incomplete"
                  )
                );
              }
              return yield* Effect.fail(error);
            })
          )
        );
        const previousTarget = proxy.swapTarget(candidate!.url);
        published = true;

        const retirementFailures: unknown[] = [];
        const retireFailure = yield* collectRollback(tryPromise(() => options.onStage?.("retire")));
        if (retireFailure !== undefined) retirementFailures.push(retireFailure);
        if (previousTarget !== undefined) {
          const idleFailure = yield* collectRollback(
            proxy.waitForTargetIdle(previousTarget, options.drainGraceMs)
          );
          if (idleFailure !== undefined) retirementFailures.push(idleFailure);
        }
        const drainFailure = yield* collectRollback(
          previousRouter.gateway.drain(options.drainGraceMs)
        );
        if (drainFailure !== undefined) retirementFailures.push(drainFailure);
        const previousCloseFailure = yield* collectRollback(previousRouter.close);
        if (previousCloseFailure !== undefined) retirementFailures.push(previousCloseFailure);
        if (retirementFailures.length > 0) {
          const error =
            retirementFailures.length === 1
              ? retirementFailures[0]
              : new AggregateError(retirementFailures, "retired router cleanup failed");
          process.stderr.write(
            `routekit retired router cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`
          );
        }
      })
    );

  return { start, replace };
}
