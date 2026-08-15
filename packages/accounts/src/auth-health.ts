import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { UpstreamAuthState } from "@velum-labs/routekit-contracts";
import type { DocumentStoreDiagnostic as StateStoreDiagnostic } from "@velum-labs/routekit-runtime";
import {
  EffectVersionedDocumentStore,
  InvalidDocumentVersion,
  makeEffectDocumentStore,
  type RouteKitPlatform,
  runRouteKitEffect
} from "@velum-labs/routekit-runtime/effect";
import { Context, Effect, FileSystem, Layer, Path, PlatformError } from "effect";

export type AuthRefreshFailureKind = "network" | "rate_limited" | "provider" | "protocol";

export type AccountAuthSnapshot = {
  kind: UpstreamAuthState;
  fingerprint: string;
  acceptedAt?: number;
  retryAt?: number;
  attempts?: number;
  failureKind?: AuthRefreshFailureKind;
  status?: 401 | 403;
  rejectedAt?: number;
  reasonCode?: string;
};

export type AuthRecoveryOutcome =
  | { kind: "accepted" | "unknown"; fingerprint: string }
  | { kind: "backoff"; fingerprint: string; retryAt: number }
  | { kind: "rejected"; fingerprint: string; status: 401 | 403 };

export type AuthRecoveryClaim = {
  identity: string;
  fingerprint: string;
  recoveryId: string;
};

type Deferred = {
  promise: Promise<AuthRecoveryOutcome>;
  resolve(value: AuthRecoveryOutcome): void;
};

type RuntimeState =
  | { kind: "unknown"; fingerprint: string }
  | { kind: "accepted"; fingerprint: string; acceptedAt: number }
  | {
      kind: "recovering";
      fingerprint: string;
      recoveryId: string;
      attempts: number;
      deferred: Deferred;
    }
  | {
      kind: "probation";
      fingerprint: string;
      recoveryId: string;
      deferred: Deferred;
    }
  | {
      kind: "backoff";
      fingerprint: string;
      retryAt: number;
      attempts: number;
      failureKind: AuthRefreshFailureKind;
    }
  | {
      kind: "rejected";
      fingerprint: string;
      status: 401 | 403;
      rejectedAt: number;
      reasonCode: string;
    };

type PersistedEntry =
  | {
      identity: string;
      fingerprint: string;
      state: "backoff";
      retryAt: number;
      attempts: number;
      failureKind: AuthRefreshFailureKind;
    }
  | {
      identity: string;
      fingerprint: string;
      state: "rejected";
      status: 401 | 403;
      rejectedAt: number;
      reasonCode: string;
    };

type SharedState = {
  entries: Map<string, RuntimeState>;
  current: Map<string, string>;
  lastPersisted?: string;
};

export type AccountAuthCoordinatorOptions = {
  statePath?: string;
  now?: () => number;
  random?: () => number;
  onDiagnostic?: (diagnostic: StateStoreDiagnostic) => void;
};

type PersistEffect<A = void> = Effect.Effect<
  A,
  InvalidDocumentVersion | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
>;

function entryKey(identity: string, fingerprint: string): string {
  return `${identity}\0${fingerprint}`;
}

function createDeferred(): Deferred {
  let settle!: (value: AuthRecoveryOutcome) => void;
  const promise = new Promise<AuthRecoveryOutcome>((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, resolve: settle };
}

function isFailureKind(value: unknown): value is AuthRefreshFailureKind {
  return (
    value === "network" || value === "rate_limited" || value === "provider" || value === "protocol"
  );
}

type PersistedAuthState = {
  version: 1;
  accounts: PersistedEntry[];
};

function decodeAuthState(value: unknown): Map<string, RuntimeState> {
  const entries = new Map<string, RuntimeState>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("auth state must be an object");
  }
  if ((value as { version?: unknown }).version !== 1) {
    throw new Error("expected auth state version 1");
  }
  const accounts = (value as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) throw new Error("auth accounts must be an array");
  for (const candidate of accounts) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("auth account entry must be an object");
    }
    const entry = candidate as Record<string, unknown>;
    const identity = entry.identity;
    const fingerprint = entry.fingerprint;
    if (
      typeof identity !== "string" ||
      typeof fingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/i.test(fingerprint)
    ) {
      throw new Error("auth account identity or fingerprint is invalid");
    }
    if (
      entry.state === "rejected" &&
      (entry.status === 401 || entry.status === 403) &&
      typeof entry.rejectedAt === "number" &&
      Number.isFinite(entry.rejectedAt) &&
      typeof entry.reasonCode === "string"
    ) {
      entries.set(entryKey(identity, fingerprint), {
        kind: "rejected",
        fingerprint,
        status: entry.status,
        rejectedAt: entry.rejectedAt,
        reasonCode: entry.reasonCode
      });
    } else if (
      entry.state === "backoff" &&
      typeof entry.retryAt === "number" &&
      Number.isFinite(entry.retryAt) &&
      typeof entry.attempts === "number" &&
      Number.isSafeInteger(entry.attempts) &&
      entry.attempts > 0 &&
      isFailureKind(entry.failureKind)
    ) {
      entries.set(entryKey(identity, fingerprint), {
        kind: "backoff",
        fingerprint,
        retryAt: entry.retryAt,
        attempts: entry.attempts,
        failureKind: entry.failureKind
      });
    } else {
      throw new Error("auth account state is invalid");
    }
  }
  return entries;
}

function encodeAuthState(entries: Map<string, RuntimeState>): PersistedAuthState {
  const accounts: PersistedEntry[] = [];
  for (const [key, state] of entries) {
    const identity = key.slice(0, key.indexOf("\0"));
    if (state.kind === "rejected") {
      accounts.push({
        identity,
        fingerprint: state.fingerprint,
        state: "rejected",
        status: state.status,
        rejectedAt: state.rejectedAt,
        reasonCode: state.reasonCode
      });
    } else if (state.kind === "backoff") {
      accounts.push({
        identity,
        fingerprint: state.fingerprint,
        state: "backoff",
        retryAt: state.retryAt,
        attempts: state.attempts,
        failureKind: state.failureKind
      });
    }
  }
  accounts.sort((left, right) => left.identity.localeCompare(right.identity));
  return { version: 1, accounts };
}

function publicSnapshot(state: RuntimeState): AccountAuthSnapshot {
  switch (state.kind) {
    case "recovering":
    case "probation":
      return { kind: "refreshing", fingerprint: state.fingerprint };
    case "unknown":
      return { kind: "unknown", fingerprint: state.fingerprint };
    case "accepted":
      return {
        kind: "accepted",
        fingerprint: state.fingerprint,
        acceptedAt: state.acceptedAt
      };
    case "backoff":
      return {
        kind: "backoff",
        fingerprint: state.fingerprint,
        retryAt: state.retryAt,
        attempts: state.attempts,
        failureKind: state.failureKind
      };
    case "rejected":
      return {
        kind: "rejected",
        fingerprint: state.fingerprint,
        status: state.status,
        rejectedAt: state.rejectedAt,
        reasonCode: state.reasonCode
      };
  }
}

export class AccountAuthCoordinator {
  readonly #store: EffectVersionedDocumentStore<PersistedAuthState> | undefined;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #abort = new AbortController();
  readonly #shared: SharedState;
  #closed = false;

  private constructor(
    store: EffectVersionedDocumentStore<PersistedAuthState> | undefined,
    now: () => number,
    random: () => number,
    shared: SharedState
  ) {
    this.#store = store;
    this.#now = now;
    this.#random = random;
    this.#shared = shared;
  }

  static open(
    options: AccountAuthCoordinatorOptions = {}
  ): Effect.Effect<AccountAuthCoordinator, PlatformError.PlatformError, RouteKitPlatform> {
    return Effect.gen(function* () {
      const store =
        options.statePath === undefined
          ? undefined
          : makeEffectDocumentStore<PersistedAuthState>({
              path: resolve(options.statePath),
              version: 1,
              decode: (value) => encodeAuthState(decodeAuthState(value)),
              encode: (value) => value,
              ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {})
            });
      const now = options.now ?? Date.now;
      const random = options.random ?? Math.random;
      if (store === undefined) {
        return new AccountAuthCoordinator(undefined, now, random, {
          entries: new Map(),
          current: new Map()
        });
      }
      const lastPersisted = yield* store.readText();
      return new AccountAuthCoordinator(store, now, random, {
        entries: decodeAuthState((yield* store.read()) ?? { version: 1, accounts: [] }),
        current: new Map(),
        ...(lastPersisted !== undefined ? { lastPersisted } : {})
      });
    });
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  register(identity: string, fingerprint: string): AccountAuthSnapshot {
    this.#assertOpen();
    const key = entryKey(identity, fingerprint);
    const existing = this.#shared.entries.get(key);
    if (existing !== undefined) {
      if (!this.#shared.current.has(identity)) this.#shared.current.set(identity, fingerprint);
      return publicSnapshot(existing);
    }
    if (!this.#shared.current.has(identity)) this.#shared.current.set(identity, fingerprint);
    const state = { kind: "unknown" as const, fingerprint };
    this.#shared.entries.set(key, state);
    return publicSnapshot(state);
  }

  snapshot(
    identity: string,
    fingerprint: string
  ): AccountAuthSnapshot | { kind: "superseded"; currentFingerprint: string } {
    const current = this.#shared.current.get(identity);
    if (current !== undefined && current !== fingerprint) {
      return { kind: "superseded", currentFingerprint: current };
    }
    const existing = this.#shared.entries.get(entryKey(identity, fingerprint));
    if (existing !== undefined) return publicSnapshot(existing);
    return this.register(identity, fingerprint);
  }

  markAccepted(identity: string, fingerprint: string): boolean {
    const current = this.#shared.current.get(identity);
    if (current !== undefined && current !== fingerprint) return false;
    const existing = this.#shared.entries.get(entryKey(identity, fingerprint));
    if (
      existing?.kind === "recovering" ||
      existing?.kind === "probation" ||
      existing?.kind === "backoff" ||
      existing?.kind === "rejected"
    ) {
      return false;
    }
    this.#shared.current.set(identity, fingerprint);
    this.#shared.entries.set(entryKey(identity, fingerprint), {
      kind: "accepted",
      fingerprint,
      acceptedAt: this.#now()
    });
    return true;
  }

  beginRecovery(
    identity: string,
    fingerprint: string
  ):
    | { role: "owner"; claim: AuthRecoveryClaim }
    | { role: "waiter"; completion: Promise<AuthRecoveryOutcome> }
    | { role: "blocked"; snapshot: AccountAuthSnapshot }
    | { role: "superseded"; currentFingerprint: string } {
    this.#assertOpen();
    const key = entryKey(identity, fingerprint);
    const existing = this.#shared.entries.get(key);
    if (existing === undefined) {
      const current = this.#shared.current.get(identity);
      if (current !== undefined && current !== fingerprint) {
        return { role: "superseded", currentFingerprint: current };
      }
    }
    const state = existing ?? { kind: "unknown" as const, fingerprint };
    if (state.kind === "recovering" || state.kind === "probation") {
      return { role: "waiter", completion: state.deferred.promise };
    }
    if (state.kind === "rejected") {
      return { role: "blocked", snapshot: publicSnapshot(state) };
    }
    if (state.kind === "backoff" && state.retryAt > this.#now()) {
      return { role: "blocked", snapshot: publicSnapshot(state) };
    }
    const recoveryId = randomUUID();
    const pending = createDeferred();
    this.#shared.current.set(identity, fingerprint);
    this.#shared.entries.set(key, {
      kind: "recovering",
      fingerprint,
      recoveryId,
      attempts: state.kind === "backoff" ? state.attempts : 0,
      deferred: pending
    });
    return { role: "owner", claim: { identity, fingerprint, recoveryId } };
  }

  markRefreshed(claim: AuthRecoveryClaim, newFingerprint: string): PersistEffect<boolean> {
    const state = this.#claimState(claim);
    if (state === undefined) return Effect.succeed(false);
    this.#shared.entries.delete(entryKey(claim.identity, claim.fingerprint));
    this.#shared.current.set(claim.identity, newFingerprint);
    this.#shared.entries.set(entryKey(claim.identity, newFingerprint), {
      kind: "probation",
      fingerprint: newFingerprint,
      recoveryId: claim.recoveryId,
      deferred: state.deferred
    });
    return Effect.as(this.#persist(), true);
  }

  finishProbation(
    claim: AuthRecoveryClaim,
    outcome:
      | { kind: "accepted" }
      | { kind: "inconclusive" }
      | { kind: "rejected"; status: 401 | 403; reasonCode: string }
  ): PersistEffect<boolean> {
    const found = this.#findProbation(claim);
    if (found === undefined) return Effect.succeed(false);
    let next: RuntimeState;
    let settled: AuthRecoveryOutcome;
    if (outcome.kind === "accepted") {
      next = {
        kind: "accepted",
        fingerprint: found.state.fingerprint,
        acceptedAt: this.#now()
      };
      settled = { kind: "accepted", fingerprint: found.state.fingerprint };
    } else if (outcome.kind === "inconclusive") {
      next = { kind: "unknown", fingerprint: found.state.fingerprint };
      settled = { kind: "unknown", fingerprint: found.state.fingerprint };
    } else {
      next = {
        kind: "rejected",
        fingerprint: found.state.fingerprint,
        status: outcome.status,
        rejectedAt: this.#now(),
        reasonCode: outcome.reasonCode
      };
      settled = {
        kind: "rejected",
        fingerprint: found.state.fingerprint,
        status: outcome.status
      };
    }
    this.#shared.entries.set(found.key, next);
    found.state.deferred.resolve(settled);
    return Effect.as(this.#persist(), true);
  }

  failRefresh(
    claim: AuthRecoveryClaim,
    failure:
      | { kind: "permanent"; status?: number; reasonCode: string }
      | {
          kind: "transient";
          failureKind: AuthRefreshFailureKind;
          retryAfter?: number;
        }
  ): PersistEffect<boolean> {
    const state = this.#claimState(claim);
    if (state === undefined) return Effect.succeed(false);
    const key = entryKey(claim.identity, claim.fingerprint);
    if (failure.kind === "permanent") {
      const status = failure.status === 403 ? 403 : 401;
      this.#shared.entries.set(key, {
        kind: "rejected",
        fingerprint: claim.fingerprint,
        status,
        rejectedAt: this.#now(),
        reasonCode: failure.reasonCode
      });
      state.deferred.resolve({ kind: "rejected", fingerprint: claim.fingerprint, status });
    } else {
      const attempts = state.attempts + 1;
      const base = Math.min(300_000, 5_000 * 2 ** Math.min(6, attempts - 1));
      const jittered = base * (0.8 + this.#random() * 0.4);
      const providerDelay = Math.max(0, failure.retryAfter ?? 0) * 1000;
      const retryAt = this.#now() + Math.max(jittered, providerDelay);
      this.#shared.entries.set(key, {
        kind: "backoff",
        fingerprint: claim.fingerprint,
        retryAt,
        attempts,
        failureKind: failure.failureKind
      });
      state.deferred.resolve({ kind: "backoff", fingerprint: claim.fingerprint, retryAt });
    }
    return Effect.as(this.#persist(), true);
  }

  completion(identity: string, fingerprint: string): Promise<AuthRecoveryOutcome> | undefined {
    const state = this.#shared.entries.get(entryKey(identity, fingerprint));
    return state?.kind === "recovering" || state?.kind === "probation"
      ? state.deferred.promise
      : undefined;
  }

  activateFingerprint(identity: string, fingerprint: string): PersistEffect {
    for (const key of [...this.#shared.entries.keys()]) {
      if (key.startsWith(`${identity}\0`) && key !== entryKey(identity, fingerprint)) {
        this.#removeEntry(key);
      }
    }
    this.#shared.current.set(identity, fingerprint);
    if (!this.#shared.entries.has(entryKey(identity, fingerprint))) {
      this.#shared.entries.set(entryKey(identity, fingerprint), {
        kind: "unknown",
        fingerprint
      });
    }
    return this.#persist();
  }

  reconcileActiveCredentials(active: ReadonlyMap<string, string>): PersistEffect {
    for (const identity of [...this.#shared.current.keys()]) {
      if (!active.has(identity)) this.#shared.current.delete(identity);
    }
    for (const key of [...this.#shared.entries.keys()]) {
      const separator = key.indexOf("\0");
      const identity = key.slice(0, separator);
      const fingerprint = key.slice(separator + 1);
      if (active.get(identity) !== fingerprint) this.#removeEntry(key);
    }
    for (const [identity, fingerprint] of active) {
      this.#shared.current.set(identity, fingerprint);
      if (!this.#shared.entries.has(entryKey(identity, fingerprint))) {
        this.#shared.entries.set(entryKey(identity, fingerprint), {
          kind: "unknown",
          fingerprint
        });
      }
    }
    return this.#persist();
  }

  rename(sourceIdentity: string, targetIdentity: string): PersistEffect {
    if (sourceIdentity === targetIdentity) return Effect.void;
    for (const key of [...this.#shared.entries.keys()]) {
      if (key.startsWith(`${targetIdentity}\0`)) this.#removeEntry(key);
    }
    for (const [key, state] of [...this.#shared.entries]) {
      if (!key.startsWith(`${sourceIdentity}\0`)) continue;
      if (state.kind === "recovering" || state.kind === "probation") {
        this.#removeEntry(key);
        this.#shared.entries.set(entryKey(targetIdentity, state.fingerprint), {
          kind: "unknown",
          fingerprint: state.fingerprint
        });
      } else {
        this.#shared.entries.delete(key);
        this.#shared.entries.set(entryKey(targetIdentity, state.fingerprint), state);
      }
    }
    const current = this.#shared.current.get(sourceIdentity);
    this.#shared.current.delete(sourceIdentity);
    this.#shared.current.delete(targetIdentity);
    if (current !== undefined) this.#shared.current.set(targetIdentity, current);
    return this.#persist();
  }

  remove(identity: string): PersistEffect {
    for (const key of [...this.#shared.entries.keys()]) {
      if (key.startsWith(`${identity}\0`)) this.#removeEntry(key);
    }
    this.#shared.current.delete(identity);
    return this.#persist();
  }

  reload(): PersistEffect {
    const self = this;
    return Effect.gen(function* () {
      if (self.#store === undefined) return;
      const text = yield* self.#store.readText();
      const durable = decodeAuthState((yield* self.#store.read()) ?? { version: 1, accounts: [] });
      for (const [key, state] of self.#shared.entries) {
        if (state.kind === "recovering" || state.kind === "probation") durable.set(key, state);
      }
      self.#shared.entries.clear();
      for (const [key, state] of durable) self.#shared.entries.set(key, state);
      self.#shared.current.clear();
      for (const key of durable.keys()) {
        const separator = key.indexOf("\0");
        self.#shared.current.set(key.slice(0, separator), key.slice(separator + 1));
      }
      self.#shared.lastPersisted = text;
    });
  }

  close(): PersistEffect {
    if (this.#closed) return Effect.void;
    this.#closed = true;
    this.#abort.abort(new Error("account auth coordinator closed"));
    for (const [key, state] of this.#shared.entries) {
      if (state.kind !== "recovering" && state.kind !== "probation") continue;
      this.#shared.entries.set(key, { kind: "unknown", fingerprint: state.fingerprint });
      state.deferred.resolve({ kind: "unknown", fingerprint: state.fingerprint });
    }
    return this.#persist();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await runRouteKitEffect(this.close());
  }

  #claimState(claim: AuthRecoveryClaim): Extract<RuntimeState, { kind: "recovering" }> | undefined {
    const state = this.#shared.entries.get(entryKey(claim.identity, claim.fingerprint));
    return state?.kind === "recovering" && state.recoveryId === claim.recoveryId
      ? state
      : undefined;
  }

  #findProbation(claim: AuthRecoveryClaim):
    | {
        key: string;
        state: Extract<RuntimeState, { kind: "probation" }>;
      }
    | undefined {
    for (const [key, state] of this.#shared.entries) {
      if (state.kind !== "probation" || state.recoveryId !== claim.recoveryId) continue;
      if (key.slice(0, key.indexOf("\0")) !== claim.identity) return undefined;
      return { key, state };
    }
    return undefined;
  }

  #persist(): PersistEffect {
    if (this.#store === undefined) return Effect.void;
    const self = this;
    return Effect.gen(function* () {
      const text = yield* self.#store!.write(encodeAuthState(self.#shared.entries));
      self.#shared.lastPersisted = text;
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("account auth coordinator is closed");
  }

  #removeEntry(key: string): void {
    const state = this.#shared.entries.get(key);
    this.#shared.entries.delete(key);
    if (state?.kind === "recovering" || state?.kind === "probation") {
      state.deferred.resolve({ kind: "unknown", fingerprint: state.fingerprint });
    }
  }
}

/**
 * Daemon-lifetime auth-health coordinator.
 *
 * @effect-expect-leaking FileSystem | Path
 */
export type AccountAuthService = Omit<AccountAuthCoordinator, "close" | "reload"> & {
  close(_unit?: void): PersistEffect;
  reload(_unit?: void): PersistEffect;
};

/** @effect-expect-leaking FileSystem | Path */
export class AccountAuth extends Context.Service<AccountAuth, AccountAuthService>()(
  "@velum-labs/routekit-accounts/AccountAuth"
) {
  static layer(options: AccountAuthCoordinatorOptions = {}) {
    return Layer.effect(AccountAuth, AccountAuthCoordinator.open(options).pipe(Effect.orDie));
  }
}
