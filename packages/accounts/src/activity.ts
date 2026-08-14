import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import type { DocumentStoreDiagnostic as StateStoreDiagnostic } from "@velum-labs/routekit-runtime";
import {
  EffectVersionedDocumentStore,
  InvalidDocumentVersion,
  makeEffectDocumentStore,
  type RouteKitPlatform
} from "@velum-labs/routekit-runtime/effect";
import { Context, Effect, FileSystem, Path, PlatformError } from "effect";
import { runCapturedPlatform } from "./captured-runtime.js";

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

type PersistedActivityState = {
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
  onDiagnostic?: (diagnostic: StateStoreDiagnostic) => void;
};

type PersistEffect = Effect.Effect<
  void,
  InvalidDocumentVersion | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
>;

/** Stable internal identity. Deliberately separate from attribution seats. */
export function subscriptionAccountIdentity(mode: SubscriptionMode, label: string): string {
  return `${mode}:${label}`;
}

function decodeActivityState(value: unknown): {
  entries: Map<string, ActivityEntry>;
  sequence: number;
} {
  const entries = new Map<string, ActivityEntry>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("activity state must be an object");
  }
  const parsed = value as Partial<PersistedActivityState>;
  if (parsed.version !== 1) throw new Error("expected activity state version 1");
  if (!Array.isArray(parsed.accounts)) throw new Error("activity accounts must be an array");
  if (
    typeof parsed.sequence !== "number" ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 0
  ) {
    throw new Error("activity sequence must be a non-negative safe integer");
  }
  let sequence = parsed.sequence;
  for (const account of parsed.accounts) {
    if (
      typeof account?.identity !== "string" ||
      typeof account.lastSelectedAt !== "number" ||
      !Number.isFinite(account.lastSelectedAt) ||
      typeof account.sequence !== "number" ||
      !Number.isSafeInteger(account.sequence) ||
      account.sequence < 0
    ) {
      throw new Error("activity account entry is invalid");
    }
    entries.set(account.identity, {
      inFlight: 0,
      lastSelectedAt: account.lastSelectedAt,
      sequence: account.sequence
    });
    sequence = Math.max(sequence, account.sequence);
  }
  return { entries, sequence };
}

/**
 * Daemon-owned account activity shared by all router generations.
 *
 * Only last-selection metadata is durable. Live attempt counts are always
 * process-local and start at zero after restart.
 */
export class AccountActivityCoordinator {
  readonly #store: EffectVersionedDocumentStore<PersistedActivityState> | undefined;
  readonly #persistDebounceMs: number;
  readonly #now: () => number;
  readonly #platform: Context.Context<RouteKitPlatform>;
  #entries: Map<string, ActivityEntry>;
  #sequence: number;
  #persistTimer: NodeJS.Timeout | undefined;
  #closed = false;

  private constructor(
    store: EffectVersionedDocumentStore<PersistedActivityState> | undefined,
    persistDebounceMs: number,
    now: () => number,
    entries: Map<string, ActivityEntry>,
    sequence: number,
    platform: Context.Context<RouteKitPlatform>
  ) {
    this.#store = store;
    this.#persistDebounceMs = persistDebounceMs;
    this.#now = now;
    this.#entries = entries;
    this.#sequence = sequence;
    this.#platform = platform;
  }

  static open(
    options: AccountActivityCoordinatorOptions = {}
  ): Effect.Effect<AccountActivityCoordinator, PlatformError.PlatformError, RouteKitPlatform> {
    return Effect.gen(function* () {
      const platform = yield* Effect.context<RouteKitPlatform>();
      const store =
        options.statePath === undefined
          ? undefined
          : makeEffectDocumentStore<PersistedActivityState>({
              path: options.statePath,
              version: 1,
              decode: (value) => {
                const decoded = decodeActivityState(value);
                return {
                  version: 1,
                  sequence: decoded.sequence,
                  accounts: [...decoded.entries].map(([identity, entry]) => ({
                    identity,
                    lastSelectedAt: entry.lastSelectedAt!,
                    sequence: entry.sequence!
                  }))
                };
              },
              encode: (value) => value,
              ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {})
            });
      const loaded =
        store === undefined
          ? { entries: new Map<string, ActivityEntry>(), sequence: 0 }
          : decodeActivityState((yield* store.read()) ?? { version: 1, sequence: 0, accounts: [] });
      return new AccountActivityCoordinator(
        store,
        options.persistDebounceMs ?? 25,
        options.now ?? Date.now,
        loaded.entries,
        loaded.sequence,
        platform
      );
    });
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
      ...(entry?.lastSelectedAt !== undefined ? { lastSelectedAt: entry.lastSelectedAt } : {}),
      lastSelected: latest === identity
    };
  }

  rename(sourceIdentity: string, targetIdentity: string): PersistEffect {
    const self = this;
    return Effect.suspend(() => {
      if (sourceIdentity === targetIdentity) return Effect.void;
      const next = new Map(self.#entries);
      const source = next.get(sourceIdentity);
      next.delete(sourceIdentity);
      next.delete(targetIdentity);
      if (source !== undefined) next.set(targetIdentity, source);
      self.#entries = next;
      return self.#persist(next);
    });
  }

  remove(identity: string): PersistEffect {
    const self = this;
    return Effect.suspend(() => {
      if (!self.#entries.has(identity)) return Effect.void;
      const next = new Map(self.#entries);
      next.delete(identity);
      self.#entries = next;
      return self.#persist(next);
    });
  }

  /**
   * Re-read durable last-selection state from disk. Used after account
   * transaction rollback so in-memory identities match the restored file.
   * Reuses live entry objects so attempt-release closures remain valid.
   */
  reload(): PersistEffect {
    const self = this;
    return Effect.gen(function* () {
      if (self.#store === undefined) return;
      const loaded = decodeActivityState(
        (yield* self.#store.read()) ?? { version: 1, sequence: 0, accounts: [] }
      );
      for (const [identity, previous] of self.#entries) {
        if (previous.inFlight <= 0) continue;
        const durable = loaded.entries.get(identity);
        if (durable !== undefined) {
          previous.lastSelectedAt = durable.lastSelectedAt;
          previous.sequence = durable.sequence;
        }
        loaded.entries.set(identity, previous);
      }
      self.#entries = loaded.entries;
      self.#sequence = Math.max(loaded.sequence, self.#sequence);
    });
  }

  flush(): PersistEffect {
    const self = this;
    return Effect.suspend(() => {
      if (self.#persistTimer !== undefined) {
        clearTimeout(self.#persistTimer);
        self.#persistTimer = undefined;
      }
      return self.#persist(self.#entries);
    });
  }

  close(): PersistEffect {
    const self = this;
    return Effect.suspend(() => {
      if (self.#closed) return Effect.void;
      self.#closed = true;
      return self.flush();
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await runCapturedPlatform(this.#platform, this.close());
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
    if (this.#store === undefined || this.#persistTimer !== undefined) return;
    const self = this;
    this.#persistTimer = setTimeout(() => {
      self.#persistTimer = undefined;
      void runCapturedPlatform(self.#platform, self.#persist(self.#entries));
    }, this.#persistDebounceMs);
    this.#persistTimer.unref();
  }

  #persist(entries: Map<string, ActivityEntry>): PersistEffect {
    if (this.#store === undefined) return Effect.void;
    const file: PersistedActivityState = {
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
    return Effect.asVoid(this.#store.write(file));
  }
}
