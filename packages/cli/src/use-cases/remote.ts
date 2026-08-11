import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";

import { CliError, type CliRuntime, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { ROUTEKIT_CONTROL_CAPABILITY } from "@velum-labs/routekit-control";

import {
  type ProvisionResult,
  type ProvisionStepId,
  provisionRemoteHost
} from "../remote-provision.js";
import {
  clearRemoteTransactionJournal,
  deleteRemoteToken,
  findRemote,
  putRemote,
  type RemoteCredentialOptions,
  type RemoteEnrollmentJournal,
  type RemoteRemovalJournal,
  type RemoteTransactionJournal,
  type RouteKitRemote,
  readRemoteRegistry,
  readRemoteToken,
  readRemoteTransactionJournal,
  recordRemoteCompensation,
  remoteRegistriesEqual,
  remoteRegistryAfterPut,
  remoteRegistryAfterRemoval,
  restoreRemoteRegistry,
  snapshotRemoteRegistry,
  writeRemoteRegistry,
  writeRemoteToken,
  writeRemoteTransactionJournal
} from "../remotes.js";
import { remoteControlClient } from "../ssh-control.js";
import { classifySshFailure } from "../ssh-exec.js";
import { routekitVersion } from "../state.js";

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
  revoke(remote: RouteKitRemote, tokenId: string): Promise<void>;
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

  async commit(): Promise<RouteKitRemote> {
    if (this.#issued === undefined || this.#remote === undefined) {
      throw new Error("remote enrollment token has not been staged");
    }
    try {
      if (this.#journal !== undefined) this.#ports.writeJournal(this.#journal);
      await this.#ports.writeCredential(this.#name, this.#issued.token);
      if (this.#journal !== undefined) {
        this.#journal = { ...this.#journal, phase: "credential-written" };
        this.#ports.writeJournal(this.#journal);
      }
      this.#ports.commitRegistry(this.#remote, this.#activate);
      if (this.#journal !== undefined) {
        this.#journal = { ...this.#journal, phase: "registry-committed" };
        this.#ports.writeJournal(this.#journal);
      }
      this.#committed = true;
      try {
        this.#ports.clearJournal();
      } catch {
        // The committed journal is self-clearing on the next remote operation.
      }
      return this.#remote;
    } catch (commitError) {
      await this.#compensate(commitError);
      throw commitError;
    }
  }

  async rollback(error: unknown): Promise<never> {
    const rollbackErrors: unknown[] = [];
    try {
      this.#ports.restoreRegistry();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await this.#ports.restoreCredential();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "remote enrollment failed and local rollback was incomplete"
      );
    }
    this.#ports.clearJournal();
    throw error;
  }

  async #compensate(commitError: unknown): Promise<void> {
    if (this.#issued === undefined || this.#remote === undefined || this.#committed) return;
    try {
      await this.#ports.revoke(this.#remote, this.#issued.id);
    } catch (compensationError) {
      try {
        this.#ports.recordCompensation(
          this.#name,
          this.#issued.id,
          compensationError instanceof Error ? compensationError.message : String(compensationError)
        );
      } catch (recordError) {
        throw new AggregateError(
          [commitError, compensationError, recordError],
          `remote enrollment failed, token ${this.#issued.id} could not be revoked, and unresolved compensation could not be recorded`
        );
      }
      throw new AggregateError(
        [commitError, compensationError],
        `remote enrollment failed and token ${this.#issued.id} could not be revoked`
      );
    }
  }
}

async function gatewayHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function issueRemoteToken(remote: RouteKitRemote): Promise<{ id: string; token: string }> {
  const label = `remote-${remote.name}@${osHostname()
    .replace(/[^a-zA-Z0-9._@-]/g, "-")
    .slice(0, 32)}`;
  try {
    const issued = await remoteControlClient(remote).call("tokens.issue", {
      label,
      plane: "data",
      createdBy: `remote-add:${remote.name}`
    });
    if (
      typeof issued.id === "string" &&
      issued.id.length > 0 &&
      typeof issued.token === "string" &&
      issued.token.length > 0
    ) {
      return { id: issued.id, token: issued.token };
    }
    throw new Error("remote RouteKit returned no gateway token");
  } catch (error) {
    const failure = classifySshFailure(error);
    if (failure.missingSshClient) {
      throw new Error("ssh was not found on PATH; install an SSH client before adding a remote");
    }
    throw new CliError({
      message:
        "could not issue a named data-plane token over SSH" +
        (failure.detail.length > 0 ? `: ${failure.detail}` : ""),
      hint: "upgrade the remote CLI so it supports `tokens.issue`, then retry"
    });
  }
}

export class EnrollRemote {
  constructor(private readonly runtime: CliRuntime = processCliRuntime) {}

  async execute(input: {
    name: string;
    gatewayUrl: string;
    sshHost: string;
    use: boolean;
  }): Promise<EnrollmentResult> {
    await recoverRemoteTransaction();
    const candidate: RouteKitRemote = {
      name: input.name,
      gatewayUrl: input.gatewayUrl,
      sshHost: input.sshHost,
      addedAt: new Date().toISOString(),
      tokenId: ""
    };
    const previousRegistry = snapshotRemoteRegistry();
    const previous = previousRegistry.registry.remotes.find((remote) => remote.name === input.name);
    const previousToken = previous === undefined ? undefined : await readRemoteToken(input.name);
    const transaction = new RemoteEnrollmentTransaction(
      { name: input.name, activate: input.use },
      {
        writeJournal: writeRemoteTransactionJournal,
        clearJournal: clearRemoteTransactionJournal,
        writeCredential: writeRemoteToken,
        commitRegistry: putRemote,
        restoreRegistry: () => restoreRemoteRegistry(previousRegistry),
        restoreCredential: async () => {
          if (previousToken === undefined) await deleteRemoteToken(input.name);
          else await writeRemoteToken(input.name, previousToken);
        },
        revoke: async (remote, tokenId) => {
          await remoteControlClient(remote).call("tokens.revoke", { id: tokenId });
        },
        recordCompensation: (remote, tokenId, reason) =>
          recordRemoteCompensation({
            remote,
            tokenId,
            action: "revoke",
            recordedAt: new Date().toISOString(),
            reason
          })
      }
    );
    try {
      const [healthy, hello] = await Promise.all([
        gatewayHealthy(candidate.gatewayUrl),
        remoteControlClient(candidate).hello()
      ]);
      if (!healthy) {
        throw new Error(`remote gateway health check failed: ${candidate.gatewayUrl}/health`);
      }
      if (hello.product !== undefined && hello.product !== "routekit") {
        throw new Error(`SSH target is not a RouteKit daemon (reported ${hello.product})`);
      }
      if (!hello.capabilities.includes(ROUTEKIT_CONTROL_CAPABILITY)) {
        throw new Error(
          `remote RouteKit does not advertise ${ROUTEKIT_CONTROL_CAPABILITY}; ` +
            "upgrade the remote CLI"
        );
      }
      const issued = await issueRemoteToken(candidate);
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
      const committedRemote = await transaction.commit();
      if (previous !== undefined && previous.tokenId !== issued.id) {
        try {
          await remoteControlClient(previous).call("tokens.revoke", { id: previous.tokenId });
        } catch (retirementError) {
          try {
            recordRemoteCompensation({
              remote: input.name,
              tokenId: previous.tokenId,
              action: "revoke",
              recordedAt: new Date().toISOString(),
              reason:
                retirementError instanceof Error ? retirementError.message : String(retirementError)
            });
          } catch (recordError) {
            this.runtime.stderr.write(
              `routekit could not record unresolved token revocation ${previous.tokenId}: ${
                recordError instanceof Error ? recordError.message : String(recordError)
              }\n`
            );
          }
        }
      }
      return {
        remote: {
          ...committedRemote,
          active: input.use || previousRegistry.registry.active === input.name,
          token: "stored",
          healthy: true,
          ...(hello.packageVersion !== undefined ? { remoteVersion: hello.packageVersion } : {}),
          ...(hello.protocolVersion !== undefined ? { protocol: hello.protocolVersion } : {})
        },
        ...(hello.packageVersion !== undefined && hello.packageVersion !== routekitVersion()
          ? { versionMismatch: hello.packageVersion }
          : {})
      };
    } catch (error) {
      return await transaction.rollback(error);
    }
  }
}

export class RemoveRemote {
  async execute(name: string): Promise<{ name: string; removed: true }> {
    await recoverRemoteTransaction();
    const existing = findRemote(name);
    if (existing === undefined) throw new Error(`unknown RouteKit remote: ${name}`);
    const registry = snapshotRemoteRegistry();
    const credential = await readRemoteToken(name);
    const nextRegistry = remoteRegistryAfterRemoval(registry, name);
    if (nextRegistry === undefined) throw new Error(`unknown RouteKit remote: ${name}`);
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
      writeJournal: writeRemoteTransactionJournal,
      clearJournal: clearRemoteTransactionJournal,
      journal,
      commitRegistry: () => writeRemoteRegistry(nextRegistry),
      deleteCredential: async () => await deleteRemoteToken(name),
      revokeRemote: async () => {
        await remoteControlClient(existing).call("tokens.revoke", { id: existing.tokenId });
      },
      restoreLocal: async () => {
        restoreRemoteRegistry(registry);
        if (credential !== undefined) await writeRemoteToken(name, credential);
      }
    });
    try {
      await transaction.commit();
    } catch (error) {
      if (error instanceof Error && error.message === "remote local state was not found") {
        throw new Error(`unknown RouteKit remote: ${name}`);
      }
      throw error;
    }
    return { name, removed: true };
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
  revokeRemote(): Promise<void>;
  restoreLocal(): Promise<void>;
};

/** Removes local authority first and restores it if remote revocation fails. */
export class RemoteRemovalTransaction {
  constructor(private readonly ports: RemoteRemovalTransactionPorts) {}

  async commit(): Promise<void> {
    let journal = this.ports.journal;
    this.ports.writeJournal(journal);
    try {
      this.ports.commitRegistry();
      journal = { ...journal, phase: "registry-removed" };
      this.ports.writeJournal(journal);
      await this.ports.deleteCredential();
      journal = { ...journal, phase: "credential-deleted" };
      this.ports.writeJournal(journal);
      await this.ports.revokeRemote();
      try {
        this.ports.clearJournal();
      } catch {
        // Recovery retries the idempotent revocation and clears the journal.
      }
    } catch (revokeError) {
      try {
        await this.ports.restoreLocal();
      } catch (restoreError) {
        throw new AggregateError(
          [revokeError, restoreError],
          "remote removal failed and local state restoration was incomplete"
        );
      }
      this.ports.clearJournal();
      throw revokeError;
    }
  }
}

export type RemoteTransactionRecoveryPorts = {
  readJournal(): RemoteTransactionJournal | undefined;
  currentRegistry(): ReturnType<typeof readRemoteRegistry>;
  restoreRegistry(snapshot: ReturnType<typeof snapshotRemoteRegistry>): void;
  readCredential(name: string): Promise<string | undefined>;
  writeCredential(name: string, token: string): Promise<void>;
  deleteCredential(name: string): Promise<void>;
  clearJournal(): void;
  revoke(remote: RouteKitRemote, tokenId: string): Promise<void>;
  recordCompensation(remote: string, tokenId: string, reason: string): void;
};

function defaultRecoveryPorts(
  credentialOptions: RemoteCredentialOptions = {}
): RemoteTransactionRecoveryPorts {
  return {
    readJournal: readRemoteTransactionJournal,
    currentRegistry: readRemoteRegistry,
    restoreRegistry: restoreRemoteRegistry,
    readCredential: async (name) => await readRemoteToken(name, credentialOptions),
    writeCredential: async (name, token) => await writeRemoteToken(name, token, credentialOptions),
    deleteCredential: async (name) => await deleteRemoteToken(name, credentialOptions),
    clearJournal: clearRemoteTransactionJournal,
    revoke: async (remote, tokenId) => {
      try {
        await remoteControlClient(remote).call("tokens.revoke", { id: tokenId });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "not_found"
        ) {
          return;
        }
        throw error;
      }
    },
    recordCompensation: (remote, tokenId, reason) =>
      recordRemoteCompensation({
        remote,
        tokenId,
        action: "revoke",
        recordedAt: new Date().toISOString(),
        reason
      })
  };
}

async function restorePreviousLocalState(
  journal: RemoteTransactionJournal,
  ports: RemoteTransactionRecoveryPorts
): Promise<void> {
  ports.restoreRegistry(journal.previousRegistry);
  if (journal.previousToken === undefined) await ports.deleteCredential(journal.name);
  else await ports.writeCredential(journal.name, journal.previousToken);
}

export async function recoverRemoteTransaction(
  ports: RemoteTransactionRecoveryPorts = defaultRecoveryPorts()
): Promise<"none" | "rolled-back" | "completed"> {
  const journal = ports.readJournal();
  if (journal === undefined) return "none";
  const registry = ports.currentRegistry();
  const token = await ports.readCredential(journal.name);
  if (journal.kind === "enrollment") {
    const localCommitted =
      remoteRegistriesEqual(registry, journal.nextRegistry) && token === journal.issuedToken;
    if (localCommitted) {
      ports.clearJournal();
      return "completed";
    }
    await restorePreviousLocalState(journal, ports);
    const remote = journal.nextRegistry.remotes.find((entry) => entry.name === journal.name);
    if (remote === undefined) {
      throw new Error(`remote enrollment recovery has no candidate for ${journal.name}`);
    }
    try {
      await ports.revoke(remote, journal.issuedTokenId);
    } catch (revokeError) {
      try {
        ports.recordCompensation(
          journal.name,
          journal.issuedTokenId,
          revokeError instanceof Error ? revokeError.message : String(revokeError)
        );
      } catch (recordError) {
        throw new AggregateError(
          [revokeError, recordError],
          `remote enrollment recovery could not revoke token ${journal.issuedTokenId} or record unresolved compensation`
        );
      }
    }
    ports.clearJournal();
    return "rolled-back";
  }
  const localRemoved = remoteRegistriesEqual(registry, journal.nextRegistry) && token === undefined;
  if (localRemoved) {
    const remote = journal.previousRegistry.registry.remotes.find(
      (entry) => entry.name === journal.name
    );
    if (remote === undefined) {
      throw new Error(`remote removal recovery has no previous remote for ${journal.name}`);
    }
    try {
      await ports.revoke(remote, journal.tokenId);
    } catch (error) {
      await restorePreviousLocalState(journal, ports);
      throw error;
    }
    ports.clearJournal();
    return "completed";
  }
  await restorePreviousLocalState(journal, ports);
  ports.clearJournal();
  return "rolled-back";
}

export class ProvisionRemote {
  constructor(private readonly enrollment: EnrollRemote) {}

  async execute(input: {
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
  }): Promise<ProvisionRemoteResult> {
    const provisioned = await provisionRemoteHost({
      host: input.sshHost,
      version: input.version,
      ...(input.force ? { force: true } : {}),
      ...(input.dryRun ? { dryRun: true } : {}),
      ...(input.onStepStart !== undefined ? { onStepStart: input.onStepStart } : {}),
      ...(input.onStep !== undefined ? { onStep: input.onStep } : {})
    });
    const enrolled =
      input.enrollment !== undefined && !input.dryRun && provisioned.gateway !== undefined
        ? await this.enrollment.execute({
            ...input.enrollment,
            sshHost: input.sshHost
          })
        : undefined;
    return { provisioned, ...(enrolled !== undefined ? { enrolled } : {}) };
  }
}
