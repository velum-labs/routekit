import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import { writeFileAtomic } from "@velum-labs/routekit-runtime/filesystem";

import {
  parseRemoteRegistry,
  type RemoteRegistrySnapshot,
  validateRemoteName
} from "../remotes.js";

export type RemoteEnrollmentJournal = {
  version: 1;
  kind: "enrollment";
  phase: "prepared" | "credential-written" | "registry-committed";
  transactionId: string;
  recordedAt: string;
  name: string;
  issuedTokenId: string;
  issuedToken: string;
  previousRegistry: RemoteRegistrySnapshot;
  previousToken?: string;
  nextRegistry: ReturnType<typeof parseRemoteRegistry>;
};

export type RemoteRemovalJournal = {
  version: 1;
  kind: "removal";
  phase: "prepared" | "registry-removed" | "credential-deleted";
  transactionId: string;
  recordedAt: string;
  name: string;
  tokenId: string;
  previousRegistry: RemoteRegistrySnapshot;
  previousToken?: string;
  nextRegistry: ReturnType<typeof parseRemoteRegistry>;
};

export type RemoteTransactionJournal = RemoteEnrollmentJournal | RemoteRemovalJournal;

function parseRegistrySnapshot(value: unknown, path: string): RemoteRegistrySnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid remote transaction registry snapshot: ${path}`);
  }
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.existed !== "boolean") {
    throw new Error(`invalid remote transaction registry snapshot: ${path}`);
  }
  return {
    existed: snapshot.existed,
    registry: parseRemoteRegistry(snapshot.registry, path)
  };
}

function parseRemoteTransactionJournal(value: unknown, path: string): RemoteTransactionJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid remote transaction journal: ${path}`);
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    (raw.kind !== "enrollment" && raw.kind !== "removal") ||
    typeof raw.transactionId !== "string" ||
    raw.transactionId.length === 0 ||
    typeof raw.recordedAt !== "string" ||
    typeof raw.name !== "string"
  ) {
    throw new Error(`invalid remote transaction journal: ${path}`);
  }
  validateRemoteName(raw.name);
  const common = {
    version: 1 as const,
    transactionId: raw.transactionId,
    recordedAt: raw.recordedAt,
    name: raw.name,
    previousRegistry: parseRegistrySnapshot(raw.previousRegistry, path),
    ...(typeof raw.previousToken === "string" ? { previousToken: raw.previousToken } : {}),
    nextRegistry: parseRemoteRegistry(raw.nextRegistry, path)
  };
  if (raw.kind === "enrollment") {
    if (
      !["prepared", "credential-written", "registry-committed"].includes(String(raw.phase)) ||
      typeof raw.issuedTokenId !== "string" ||
      raw.issuedTokenId.length === 0 ||
      typeof raw.issuedToken !== "string" ||
      raw.issuedToken.length === 0
    ) {
      throw new Error(`invalid remote enrollment transaction journal: ${path}`);
    }
    return {
      ...common,
      kind: "enrollment",
      phase: raw.phase as RemoteEnrollmentJournal["phase"],
      issuedTokenId: raw.issuedTokenId,
      issuedToken: raw.issuedToken
    };
  }
  if (
    !["prepared", "registry-removed", "credential-deleted"].includes(String(raw.phase)) ||
    typeof raw.tokenId !== "string" ||
    raw.tokenId.length === 0
  ) {
    throw new Error(`invalid remote removal transaction journal: ${path}`);
  }
  return {
    ...common,
    kind: "removal",
    phase: raw.phase as RemoteRemovalJournal["phase"],
    tokenId: raw.tokenId
  };
}

export class RemoteTransactionJournalRepository {
  path(): string {
    return join(routekitHome(), "remote-transaction.v1.json");
  }

  write(journal: RemoteTransactionJournal): void {
    const path = this.path();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(
      path,
      `${JSON.stringify(parseRemoteTransactionJournal(journal, path), null, 2)}\n`,
      { mode: 0o600 }
    );
    chmodSync(path, 0o600);
  }

  read(): RemoteTransactionJournal | undefined {
    const path = this.path();
    if (!existsSync(path)) return undefined;
    return parseRemoteTransactionJournal(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  }

  clear(): void {
    const path = this.path();
    if (existsSync(path)) unlinkSync(path);
  }
}
