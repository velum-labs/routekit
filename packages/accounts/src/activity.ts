import { existsSync, readFileSync } from "node:fs";

import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

export type AccountActivitySnapshot = {
  serving: boolean;
  inFlight: number;
  lastSelectedAt?: number;
  lastSelected: boolean;
};

type ActivityEntry = {
  inFlight: number;
  lastSelectedAt?: number;
  sequence?: number;
};

type PersistedActivityFile = {
  version: 1;
  sequence: number;
  accounts: Array<{
    identity: string;
    lastSelectedAt: number;
    sequence: number;
  }>;
};

export type AccountActivityCoordinatorOptions = {
  statePath?: string;
  persistDebounceMs?: number;
  now?: () => number;
};

/** Stable internal identity. Deliberately separate from attribution seats. */
export function subscriptionAccountIdentity(mode: SubscriptionMode, label: string): string {
  return `${mode}:${label}`;
}

function readState(path: string): {
  entries: Map<string, ActivityEntry>;
  sequence: number;
} {
  const entries = new Map<string, ActivityEntry>();
  if (!existsSync(path)) return { entries, sequence: 0 };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedActivityFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      return { entries, sequence: 0 };
    }
    let sequence =
      typeof parsed.sequence === "number" && Number.isSafeInteger(parsed.sequence)
        ? parsed.sequence
        : 0;
    for (const account of parsed.accounts) {
      if (
        typeof account?.identity !== "string" ||
        typeof account.lastSelectedAt !== "number" ||
        !Number.isFinite(account.lastSelectedAt) ||
        typeof account.sequence !== "number" ||
        !Number.isSafeInteger(account.sequence)
      ) {
        continue;
      }
      entries.set(account.identity, {
        inFlight: 0,
        lastSelectedAt: account.lastSelectedAt,
        sequence: account.sequence
      });
      sequence = Math.max(sequence, account.sequence);
    }
    return { entries, sequence };
  } catch {
    return { entries, sequence: 0 };
  }
}

/**
 * Daemon-owned account activity shared by all router generations.
 *
 * Only last-selection metadata is durable. Live attempt counts are always
 * process-local and start at zero after restart.
 */
export class AccountActivityCoordinator {
  readonly #statePath: string | undefined;
  readonly #persistDebounceMs: number;
  readonly #now: () => number;
  #entries: Map<string, ActivityEntry>;
  #sequence: number;
  #persistTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: AccountActivityCoordinatorOptions = {}) {
    this.#statePath = options.statePath;
    this.#persistDebounceMs = options.persistDebounceMs ?? 25;
    this.#now = options.now ?? Date.now;
    const loaded =
      this.#statePath === undefined
        ? { entries: new Map<string, ActivityEntry>(), sequence: 0 }
        : readState(this.#statePath);
    this.#entries = loaded.entries;
    this.#sequence = loaded.sequence;
  }

  beginAttempt(identity: string): () => void {
    if (this.#closed) throw new Error("account activity coordinator is closed");
    const entry = this.#entries.get(identity) ?? { inFlight: 0 };
    entry.inFlight += 1;
    entry.lastSelectedAt = this.#now();
    entry.sequence = ++this.#sequence;
    this.#entries.set(identity, entry);
    this.#schedulePersist();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
    };
  }

  snapshot(identity: string): AccountActivitySnapshot {
    const entry = this.#entries.get(identity);
    const latest = this.#latestIdentity();
    const inFlight = entry?.inFlight ?? 0;
    return {
      serving: inFlight > 0,
      inFlight,
      ...(entry?.lastSelectedAt !== undefined
        ? { lastSelectedAt: entry.lastSelectedAt }
        : {}),
      lastSelected: latest === identity
    };
  }

  rename(sourceIdentity: string, targetIdentity: string): void {
    if (sourceIdentity === targetIdentity) return;
    const next = new Map(this.#entries);
    const source = next.get(sourceIdentity);
    next.delete(sourceIdentity);
    next.delete(targetIdentity);
    if (source !== undefined) next.set(targetIdentity, source);
    this.#persist(next);
    this.#entries = next;
  }

  remove(identity: string): void {
    if (!this.#entries.has(identity)) return;
    const next = new Map(this.#entries);
    next.delete(identity);
    this.#persist(next);
    this.#entries = next;
  }

  /**
   * Re-read durable last-selection state from disk. Used after account
   * transaction rollback so in-memory identities match the restored file.
   * Reuses live entry objects so attempt-release closures remain valid.
   */
  reload(): void {
    if (this.#statePath === undefined) return;
    const loaded = readState(this.#statePath);
    for (const [identity, previous] of this.#entries) {
      if (previous.inFlight <= 0) continue;
      const durable = loaded.entries.get(identity);
      if (durable !== undefined) {
        previous.lastSelectedAt = durable.lastSelectedAt;
        previous.sequence = durable.sequence;
      }
      loaded.entries.set(identity, previous);
    }
    this.#entries = loaded.entries;
    this.#sequence = Math.max(loaded.sequence, this.#sequence);
  }

  flush(): void {
    if (this.#persistTimer !== undefined) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = undefined;
    }
    this.#persist(this.#entries);
  }

  close(): void {
    if (this.#closed) return;
    this.flush();
    this.#closed = true;
  }

  #latestIdentity(): string | undefined {
    let latest: { identity: string; at: number; sequence: number } | undefined;
    for (const [identity, entry] of this.#entries) {
      if (entry.lastSelectedAt === undefined || entry.sequence === undefined) continue;
      if (
        latest === undefined ||
        entry.lastSelectedAt > latest.at ||
        (entry.lastSelectedAt === latest.at && entry.sequence > latest.sequence)
      ) {
        latest = { identity, at: entry.lastSelectedAt, sequence: entry.sequence };
      }
    }
    return latest?.identity;
  }

  #schedulePersist(): void {
    if (this.#statePath === undefined || this.#persistTimer !== undefined) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      this.#persist(this.#entries);
    }, this.#persistDebounceMs);
    this.#persistTimer.unref();
  }

  #persist(entries: Map<string, ActivityEntry>): void {
    if (this.#statePath === undefined) return;
    const file: PersistedActivityFile = {
      version: 1,
      sequence: this.#sequence,
      accounts: [...entries]
        .flatMap(([identity, entry]) =>
          entry.lastSelectedAt === undefined || entry.sequence === undefined
            ? []
            : [{ identity, lastSelectedAt: entry.lastSelectedAt, sequence: entry.sequence }]
        )
        .sort((left, right) => left.identity.localeCompare(right.identity))
    };
    writeFileAtomic(this.#statePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}
