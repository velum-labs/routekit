import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";

import { CliError, type CliRuntime, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { ROUTEKIT_CONTROL_CAPABILITY } from "@velum-labs/routekit-control";
import {
  RouteKitFailure,
  type RouteKitPlatform,
  routeKitError,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { cliTry, cliTryPromise } from "../../cli-session.js";
import { gatewayHealthy } from "../../adapters/gateway-probe.js";
import {
  type ProvisionResult,
  type ProvisionStepId,
  provisionRemoteHost
} from "../../remote-provision.js";
import type { RemoteStores } from "../../repositories/stores.js";
import type {
  RemoteEnrollmentJournal,
  RemoteRemovalJournal,
  RemoteTransactionJournal
} from "../../repositories/remote-transaction-journal.js";
import {
  type RouteKitRemote,
  remoteRegistriesEqual,
  remoteRegistryAfterPut,
  remoteRegistryAfterRemoval
} from "../../remotes.js";
import { remoteControlClient } from "../../adapters/ssh-control.js";
import { classifySshFailure } from "../../adapters/ssh-exec.js";
import { routekitVersion } from "../../state.js";

export type EnrolledRemote = RouteKitRemote & {
  active: boolean;
  token: "stored";
  healthy: true;
  remoteVersion?: string;
  protocol?: string;
};

export type EnrollmentResult = {
  remote: EnrolledRemote;
  versionMismatch?: string;
};

export type RemoteEnrollmentTransactionPorts = {
  writeJournal(journal: RemoteEnrollmentJournal): void;
  clearJournal(): void;
  writeCredential(name: string, token: string): Promise<void>;
  commitRegistry(remote: RouteKitRemote, activate: boolean): void;
  restoreRegistry(): void;
  restoreCredential(): Promise<void>;
  revoke(remote: RouteKitRemote, tokenId: string): Effect.Effect<void, Error, RouteKitPlatform>;
  recordCompensation(remote: string, tokenId: string, reason: string): void;
};

/** Unit of work for one issued remote token and its local enrollment commit. */
export class RemoteEnrollmentTransaction {
  readonly #ports: RemoteEnrollmentTransactionPorts;
  readonly #name: string;
  readonly #activate: boolean;
  #issued: { id: string; token: string } | undefined;
  #remote: RouteKitRemote | undefined;
  #journal: RemoteEnrollmentJournal | undefined;
  #committed = false;

  constructor(input: { name: string; activate: boolean }, ports: RemoteEnrollmentTransactionPorts) {
    this.#name = input.name;
    this.#activate = input.activate;
    this.#ports = ports;
  }

  stage(
    remote: RouteKitRemote,
    issued: { id: string; token: string },
    journal?: RemoteEnrollmentJournal
  ): RouteKitRemote {
    if (this.#issued !== undefined) throw new Error("remote enrollment token already staged");
    this.#issued = issued;
    this.#remote = { ...remote, tokenId: issued.id };
    this.#journal = journal;
    return this.#remote;
  }

  commit() {
    const self = this;
    return Effect.gen(function* () {
      if (self.#issued === undefined || self.#remote === undefined) {
        return yield* new RouteKitFailure({
          message: "remote enrollment token has not been staged"
        });
      }
      const issued = self.#issued;
      const remote = self.#remote;
      return yield* Effect.gen(function* () {
        if (self.#journal !== undefined) {
          yield* cliTry(() => self.#ports.writeJournal(self.#journal!));
        }
        yield* cliTryPromise(() => self.#ports.writeCredential(self.#name, issued.token));
        if (self.#journal !== undefined) {
          self.#journal = { ...self.#journal, phase: "credential-written" };
          yield* cliTry(() => self.#ports.writeJournal(self.#journal!));
        }
        yield* cliTry(() => self.#ports.commitRegistry(remote, self.#activate));
        if (self.#journal !== undefined) {
          self.#journal = { ...self.#journal, phase: "registry-committed" };
          yield* cliTry(() => self.#ports.writeJournal(self.#journal!));
        }
        self.#committed = true;
        yield* cliTry(() => self.#ports.clearJournal()).pipe(Effect.ignore);
        return remote;
      }).pipe(
        Effect.catch((commitError) =>
          self.#compensate(commitError).pipe(Effect.andThen(Effect.fail(commitError)))
        )
      );
    });
  }

  rollback(error: unknown) {
    const self = this;
    return Effect.gen(function* () {
      const rollbackErrors: unknown[] = [];
      yield* cliTry(() => self.#ports.restoreRegistry()).pipe(
        Effect.catch((rollbackError) => {
          rollbackErrors.push(rollbackError);
          return Effect.void;
        })
      );
      yield* cliTryPromise(() => self.#ports.restoreCredential()).pipe(
        Effect.catch((rollbackError) => {
          rollbackErrors.push(rollbackError);
          return Effect.void;
        })
      );
      if (rollbackErrors.length > 0) {
        return yield* Effect.fail(
          new AggregateError(
            [error, ...rollbackErrors].map(routeKitError),
            "remote enrollment failed and local rollback was incomplete"
          )
        );
      }
      yield* cliTry(() => self.#ports.clearJournal());
      return yield* toRouteKitFailure(error);
    });
  }

  #compensate(commitError: unknown) {
    const self = this;
    return Effect.gen(function* () {
      if (self.#issued === undefined || self.#remote === undefined || self.#committed) return;
      const issued = self.#issued;
      const remote = self.#remote;
      yield* self.#ports.revoke(remote, issued.id).pipe(
        Effect.catch((compensationError) =>
          Effect.gen(function* () {
            yield* cliTry(() =>
              self.#ports.recordCompensation(
                self.#name,
                issued.id,
                compensationError instanceof Error
                  ? compensationError.message
                  : String(compensationError)
              )
            ).pipe(
              Effect.mapError(
                (recordError) =>
                  new AggregateError(
                    [commitError, compensationError, recordError].map(routeKitError),
                    `remote enrollment failed, token ${issued.id} could not be revoked, and unresolved compensation could not be recorded`
                  )
              )
            );
            return yield* Effect.fail(
              new AggregateError(
                [commitError, compensationError].map(routeKitError),
                `remote enrollment failed and token ${issued.id} could not be revoked`
              )
            );
          })
        )
      );
    });
  }
}

function issueRemoteToken(remote: RouteKitRemote) {
  const label = `remote-${remote.name}@${osHostname()
    .replace(/[^a-zA-Z0-9._@-]/g, "-")
    .slice(0, 32)}`;
  return remoteControlClient(remote)
    .call("tokens.issue", {
      label,
      plane: "data",
      createdBy: `remote-add:${remote.name}`
    })
    .pipe(
      Effect.flatMap((issued) => {
        if (
          typeof issued.id === "string" &&
          issued.id.length > 0 &&
          typeof issued.token === "string" &&
          issued.token.length > 0
        ) {
          return Effect.succeed({ id: issued.id, token: issued.token });
        }
        return new RouteKitFailure({
          message: "remote RouteKit returned no gateway token"
        });
      }),
      Effect.mapError((error) => {
        const failure = classifySshFailure(error);
        if (failure.missingSshClient) {
          return new RouteKitFailure({
            message: "ssh was not found on PATH; install an SSH client before adding a remote"
          });
        }
        return new CliError({
          message:
            "could not issue a named data-plane token over SSH" +
            (failure.detail.length > 0 ? `: ${failure.detail}` : ""),
          hint: "upgrade the remote CLI so it supports `tokens.issue`, then retry"
        });
      })
    );
}

export class EnrollRemote {
  constructor(
    private readonly stores: RemoteStores,
    private readonly runtime: CliRuntime = processCliRuntime
  ) {}

  execute(input: { name: string; gatewayUrl: string; sshHost: string; use: boolean }) {
    const self = this;
    return Effect.gen(function* () {
      yield* recoverRemoteTransaction(defaultRecoveryPorts(self.stores));
      const candidate: RouteKitRemote = {
        name: input.name,
        gatewayUrl: input.gatewayUrl,
        sshHost: input.sshHost,
        addedAt: new Date().toISOString(),
        tokenId: ""
      };
      const previousRegistry = self.stores.registry.snapshot();
      const previous = previousRegistry.registry.remotes.find(
        (remote) => remote.name === input.name
      );
      const previousToken =
        previous === undefined
          ? undefined
          : yield* cliTryPromise(() => self.stores.credentials.read(input.name));
      const transaction = new RemoteEnrollmentTransaction(
        { name: input.name, activate: input.use },
        {
          writeJournal: (journal) => self.stores.journal.write(journal),
          clearJournal: () => self.stores.journal.clear(),
          writeCredential: async (name, token) => await self.stores.credentials.write(name, token),
          commitRegistry: (remote, activate) => self.stores.registry.put(remote, activate),
          restoreRegistry: () => self.stores.registry.restore(previousRegistry),
          restoreCredential: async () => {
            if (previousToken === undefined) await self.stores.credentials.delete(input.name);
            else await self.stores.credentials.write(input.name, previousToken);
          },
          revoke: (remote, tokenId) =>
            remoteControlClient(remote).call("tokens.revoke", { id: tokenId }).pipe(Effect.asVoid),
          recordCompensation: (remote, tokenId, reason) =>
            self.stores.compensations.record({
              remote,
              tokenId,
              action: "revoke",
              recordedAt: new Date().toISOString(),
              reason
            })
        }
      );
      return yield* Effect.gen(function* () {
        const [healthy, hello] = yield* Effect.all(
          [gatewayHealthy(candidate.gatewayUrl), remoteControlClient(candidate).hello()],
          { concurrency: "unbounded" }
        );
        if (!healthy) {
          return yield* new RouteKitFailure({
            message: `remote gateway health check failed: ${candidate.gatewayUrl}/health`
          });
        }
        if (hello.product !== undefined && hello.product !== "routekit") {
          return yield* new RouteKitFailure({
            message: `SSH target is not a RouteKit daemon (reported ${hello.product})`
          });
        }
        if (!hello.capabilities.includes(ROUTEKIT_CONTROL_CAPABILITY)) {
          return yield* new RouteKitFailure({
            message:
              `remote RouteKit does not advertise ${ROUTEKIT_CONTROL_CAPABILITY}; ` +
              "upgrade the remote CLI"
          });
        }
        const issued = yield* issueRemoteToken(candidate);
        const remote = { ...candidate, tokenId: issued.id };
        transaction.stage(candidate, issued, {
          version: 1,
          kind: "enrollment",
          phase: "prepared",
          transactionId: randomUUID(),
          recordedAt: new Date().toISOString(),
          name: input.name,
          issuedTokenId: issued.id,
          issuedToken: issued.token,
          previousRegistry,
          ...(previousToken !== undefined ? { previousToken } : {}),
          nextRegistry: remoteRegistryAfterPut(previousRegistry, remote, input.use)
        });
        const committedRemote = yield* transaction.commit();
        if (previous !== undefined && previous.tokenId !== issued.id) {
          yield* remoteControlClient(previous)
            .call("tokens.revoke", { id: previous.tokenId })
            .pipe(
              Effect.catch((retirementError) =>
                cliTry(() => {
                  try {
                    self.stores.compensations.record({
                      remote: input.name,
                      tokenId: previous.tokenId,
                      action: "revoke",
                      recordedAt: new Date().toISOString(),
                      reason:
                        retirementError instanceof Error
                          ? retirementError.message
                          : String(retirementError)
                    });
                  } catch (recordError) {
                    self.runtime.stderr.write(
                      `routekit could not record unresolved token revocation ${previous.tokenId}: ${
                        recordError instanceof Error ? recordError.message : String(recordError)
                      }\n`
                    );
                  }
                })
              )
            );
        }
        return {
          remote: {
            ...committedRemote,
            active: input.use || previousRegistry.registry.active === input.name,
            token: "stored" as const,
            healthy: true as const,
            ...(hello.packageVersion !== undefined ? { remoteVersion: hello.packageVersion } : {}),
            ...(hello.protocolVersion !== undefined ? { protocol: hello.protocolVersion } : {})
          },
          ...(hello.packageVersion !== undefined && hello.packageVersion !== routekitVersion()
            ? { versionMismatch: hello.packageVersion }
            : {})
        };
      }).pipe(Effect.catch((error) => transaction.rollback(error)));
    });
  }
}

export class RemoveRemote {
  constructor(private readonly stores: RemoteStores) {}

  execute(name: string) {
    const self = this;
    return Effect.gen(function* () {
      yield* recoverRemoteTransaction(defaultRecoveryPorts(self.stores));
      const existing = yield* cliTry(() => {
        const found = self.stores.registry.find(name);
        if (found === undefined) {
          throw new RouteKitFailure({ message: `unknown RouteKit remote: ${name}` });
        }
        return found;
      });
      const registry = self.stores.registry.snapshot();
      const credential = yield* cliTryPromise(() => self.stores.credentials.read(name));
      const nextRegistry = yield* cliTry(() => {
        const next = remoteRegistryAfterRemoval(registry, name);
        if (next === undefined) {
          throw new RouteKitFailure({ message: `unknown RouteKit remote: ${name}` });
        }
        return next;
      });
      const journal: RemoteRemovalJournal = {
        version: 1,
        kind: "removal",
        phase: "prepared",
        transactionId: randomUUID(),
        recordedAt: new Date().toISOString(),
        name,
        tokenId: existing.tokenId,
        previousRegistry: registry,
        ...(credential !== undefined ? { previousToken: credential } : {}),
        nextRegistry
      };
      const transaction = new RemoteRemovalTransaction({
        writeJournal: (entry) => self.stores.journal.write(entry),
        clearJournal: () => self.stores.journal.clear(),
        journal,
        commitRegistry: () => self.stores.registry.write(nextRegistry),
        deleteCredential: async () => await self.stores.credentials.delete(name),
        revokeRemote: () =>
          remoteControlClient(existing)
            .call("tokens.revoke", { id: existing.tokenId })
            .pipe(Effect.asVoid),
        restoreLocal: async () => {
          self.stores.registry.restore(registry);
          if (credential !== undefined) await self.stores.credentials.write(name, credential);
        }
      });
      yield* transaction.commit().pipe(
        Effect.mapError((error) => {
          if (error instanceof Error && error.message === "remote local state was not found") {
            return new RouteKitFailure({ message: `unknown RouteKit remote: ${name}` });
          }
          return toRouteKitFailure(error);
        })
      );
      return { name, removed: true as const };
    });
  }
}

export type ProvisionRemoteResult = {
  provisioned: ProvisionResult;
  enrolled?: EnrollmentResult;
};

export type RemoteRemovalTransactionPorts = {
  writeJournal(journal: RemoteRemovalJournal): void;
  clearJournal(): void;
  journal: RemoteRemovalJournal;
  commitRegistry(): void;
  deleteCredential(): Promise<void>;
  revokeRemote(): Effect.Effect<void, Error, RouteKitPlatform>;
  restoreLocal(): Promise<void>;
};

/** Removes local authority first and restores it if remote revocation fails. */
export class RemoteRemovalTransaction {
  constructor(private readonly ports: RemoteRemovalTransactionPorts) {}

  commit() {
    const self = this;
    return Effect.gen(function* () {
      let journal = self.ports.journal;
      yield* cliTry(() => self.ports.writeJournal(journal));
      yield* Effect.gen(function* () {
        yield* cliTry(() => self.ports.commitRegistry());
        journal = { ...journal, phase: "registry-removed" };
        yield* cliTry(() => self.ports.writeJournal(journal));
        yield* cliTryPromise(() => self.ports.deleteCredential());
        journal = { ...journal, phase: "credential-deleted" };
        yield* cliTry(() => self.ports.writeJournal(journal));
        yield* self.ports.revokeRemote();
        yield* cliTry(() => self.ports.clearJournal()).pipe(Effect.ignore);
      }).pipe(
        Effect.catch((revokeError) =>
          Effect.gen(function* () {
            yield* cliTryPromise(() => self.ports.restoreLocal()).pipe(
              Effect.mapError(
                (restoreError) =>
                  new AggregateError(
                    [revokeError, restoreError].map(routeKitError),
                    "remote removal failed and local state restoration was incomplete"
                  )
              )
            );
            yield* cliTry(() => self.ports.clearJournal());
            return yield* Effect.fail(revokeError);
          })
        )
      );
    });
  }
}

export type RemoteTransactionRecoveryPorts = {
  readJournal(): RemoteTransactionJournal | undefined;
  currentRegistry(): ReturnType<RemoteStores["registry"]["read"]>;
  restoreRegistry(snapshot: ReturnType<RemoteStores["registry"]["snapshot"]>): void;
  readCredential(name: string): Promise<string | undefined>;
  writeCredential(name: string, token: string): Promise<void>;
  deleteCredential(name: string): Promise<void>;
  clearJournal(): void;
  revoke(remote: RouteKitRemote, tokenId: string): Effect.Effect<void, Error, RouteKitPlatform>;
  recordCompensation(remote: string, tokenId: string, reason: string): void;
};

function defaultRecoveryPorts(stores: RemoteStores): RemoteTransactionRecoveryPorts {
  return {
    readJournal: () => stores.journal.read(),
    currentRegistry: () => stores.registry.read(),
    restoreRegistry: (snapshot) => stores.registry.restore(snapshot),
    readCredential: async (name) => await stores.credentials.read(name),
    writeCredential: async (name, token) => await stores.credentials.write(name, token),
    deleteCredential: async (name) => await stores.credentials.delete(name),
    clearJournal: () => stores.journal.clear(),
    revoke: (remote, tokenId) =>
      remoteControlClient(remote)
        .call("tokens.revoke", { id: tokenId })
        .pipe(
          Effect.asVoid,
          Effect.catch((error) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "not_found"
            ) {
              return Effect.void;
            }
            return toRouteKitFailure(error);
          })
        ),
    recordCompensation: (remote, tokenId, reason) =>
      stores.compensations.record({
        remote,
        tokenId,
        action: "revoke",
        recordedAt: new Date().toISOString(),
        reason
      })
  };
}

function restorePreviousLocalState(
  journal: RemoteTransactionJournal,
  ports: RemoteTransactionRecoveryPorts
) {
  return Effect.gen(function* () {
    yield* cliTry(() => ports.restoreRegistry(journal.previousRegistry));
    const previousToken = journal.previousToken;
    if (previousToken === undefined) {
      yield* cliTryPromise(() => ports.deleteCredential(journal.name));
    } else {
      yield* cliTryPromise(() => ports.writeCredential(journal.name, previousToken));
    }
  });
}

export function recoverRemoteTransaction(ports: RemoteTransactionRecoveryPorts) {
  return Effect.gen(function* () {
    const journal = yield* cliTry(() => ports.readJournal());
    if (journal === undefined) return "none" as const;
    const registry = yield* cliTry(() => ports.currentRegistry());
    const token = yield* cliTryPromise(() => ports.readCredential(journal.name));
    if (journal.kind === "enrollment") {
      const localCommitted =
        remoteRegistriesEqual(registry, journal.nextRegistry) && token === journal.issuedToken;
      if (localCommitted) {
        yield* cliTry(() => ports.clearJournal());
        return "completed" as const;
      }
      yield* restorePreviousLocalState(journal, ports);
      const remote = journal.nextRegistry.remotes.find((entry) => entry.name === journal.name);
      if (remote === undefined) {
        return yield* new RouteKitFailure({
          message: `remote enrollment recovery has no candidate for ${journal.name}`
        });
      }
      yield* ports
        .revoke(remote, journal.issuedTokenId)
        .pipe(
          Effect.catch((revokeError) =>
            cliTry(() =>
              ports.recordCompensation(
                journal.name,
                journal.issuedTokenId,
                revokeError instanceof Error ? revokeError.message : String(revokeError)
              )
            ).pipe(
              Effect.mapError(
                (recordError) =>
                  new AggregateError(
                    [revokeError, recordError].map(routeKitError),
                    `remote enrollment recovery could not revoke token ${journal.issuedTokenId} or record unresolved compensation`
                  )
              )
            )
          )
        );
      yield* cliTry(() => ports.clearJournal());
      return "rolled-back" as const;
    }
    const localRemoved =
      remoteRegistriesEqual(registry, journal.nextRegistry) && token === undefined;
    if (localRemoved) {
      const remote = journal.previousRegistry.registry.remotes.find(
        (entry) => entry.name === journal.name
      );
      if (remote === undefined) {
        return yield* new RouteKitFailure({
          message: `remote removal recovery has no previous remote for ${journal.name}`
        });
      }
      yield* ports
        .revoke(remote, journal.tokenId)
        .pipe(
          Effect.catch((error) =>
            restorePreviousLocalState(journal, ports).pipe(Effect.andThen(Effect.fail(error)))
          )
        );
      yield* cliTry(() => ports.clearJournal());
      return "completed" as const;
    }
    yield* restorePreviousLocalState(journal, ports);
    yield* cliTry(() => ports.clearJournal());
    return "rolled-back" as const;
  });
}

export class ProvisionRemote {
  constructor(private readonly enrollment: EnrollRemote) {}

  execute(input: {
    sshHost: string;
    version: string;
    force: boolean;
    dryRun: boolean;
    enrollment?: {
      name: string;
      gatewayUrl: string;
      use: boolean;
    };
    onStepStart?: (id: ProvisionStepId) => void;
    onStep?: Parameters<typeof provisionRemoteHost>[0]["onStep"];
  }) {
    const self = this;
    return Effect.gen(function* () {
      const provisioned = yield* cliTryPromise(() =>
        provisionRemoteHost({
          host: input.sshHost,
          version: input.version,
          ...(input.force ? { force: true } : {}),
          ...(input.dryRun ? { dryRun: true } : {}),
          ...(input.onStepStart !== undefined ? { onStepStart: input.onStepStart } : {}),
          ...(input.onStep !== undefined ? { onStep: input.onStep } : {})
        })
      );
      const enrolled =
        input.enrollment !== undefined && !input.dryRun && provisioned.gateway !== undefined
          ? yield* self.enrollment.execute({
              ...input.enrollment,
              sshHost: input.sshHost
            })
          : undefined;
      return { provisioned, ...(enrolled !== undefined ? { enrolled } : {}) };
    });
  }
}
