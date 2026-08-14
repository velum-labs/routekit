import { resolve } from "node:path";

import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import {
  EffectVersionedDocumentStore,
  InvalidDocumentVersion,
  makeEffectDocumentStore,
  RouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect, FileSystem, Path, PlatformError } from "effect";

import { canonicalRateLimitWindowKey } from "./provider.js";
import {
  type CooldownContext,
  decodeRateLimitTrackerState,
  type PersistedMemberState,
  type PersistedTrackerFile,
  type TrackerStateRead
} from "./rate-limit-tracker-codec.js";
import type { AccountLimits } from "./types.js";

export type { CooldownContext } from "./rate-limit-tracker-codec.js";

type PersistEffect<A = void> = Effect.Effect<
  A,
  InvalidDocumentVersion | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
>;

function stateStore(
  path: string,
  mode?: SubscriptionMode
): EffectVersionedDocumentStore<TrackerStateRead> {
  return makeEffectDocumentStore({
    path,
    version: 1,
    decode: (value) => decodeRateLimitTrackerState(value, mode),
    encode: ({ state }) =>
      ({
        version: 1,
        members: [...state].map(([id, member]) => ({ id, ...member }))
      }) satisfies PersistedTrackerFile
  });
}

function mergeLimits(
  previous: AccountLimits | undefined,
  next: AccountLimits,
  mode?: SubscriptionMode
): AccountLimits {
  const windows = Object.create(null) as AccountLimits["windows"];
  const sources =
    next.completeness === "snapshot" ? [next.windows] : [previous?.windows, next.windows];
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [key, window] of Object.entries(source)) {
      Object.defineProperty(
        windows,
        mode === undefined ? key : canonicalRateLimitWindowKey(mode, key),
        {
          value: window,
          enumerable: true,
          configurable: true,
          writable: true
        }
      );
    }
  }
  const resetCredits = next.resetCredits ?? previous?.resetCredits;
  const merged =
    next.completeness === "snapshot"
      ? { ...next, windows }
      : {
          ...previous,
          ...next,
          windows,
          observedAt: next.observedAt,
          source: next.source
        };
  const { diagnostics: _previousDiagnostics, ...withoutDiagnostics } = merged;
  return {
    ...withoutDiagnostics,
    ...(next.diagnostics !== undefined ? { diagnostics: next.diagnostics } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {})
  };
}

type SharedTrackerState = {
  mode: SubscriptionMode | undefined;
  members: Map<string, PersistedMemberState>;
  /** Exact text this process last wrote, so external edits stay detectable. */
  lastPersisted: string | undefined;
};

/**
 * Trackers for one state file share mutable state process-wide. A daemon
 * reload runs the candidate router before the previous one drains, so
 * independent maps would let a candidate probe replace the whole file and
 * silently discard a cooldown the draining generation just wrote.
 */
const sharedTrackerStates = new Map<string, SharedTrackerState>();

export class RateLimitTracker {
  readonly #statePath: string;
  readonly #mode: SubscriptionMode | undefined;
  readonly #shared: SharedTrackerState;
  readonly #state: Map<string, PersistedMemberState>;
  readonly #store: EffectVersionedDocumentStore<TrackerStateRead>;

  private constructor(
    statePath: string,
    mode: SubscriptionMode | undefined,
    shared: SharedTrackerState,
    store: EffectVersionedDocumentStore<TrackerStateRead>
  ) {
    this.#statePath = statePath;
    this.#mode = mode;
    this.#shared = shared;
    this.#state = shared.members;
    this.#store = store;
  }

  static open(
    statePath: string,
    mode?: SubscriptionMode
  ): Effect.Effect<
    RateLimitTracker,
    Error | InvalidDocumentVersion | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const resolved = resolve(statePath);
    const store = stateStore(resolved, mode);
    return Effect.gen(function* () {
      const shared = sharedTrackerStates.get(resolved);
      if (shared !== undefined) {
        if (shared.mode !== mode) {
          return yield* Effect.fail(
            new RouteKitFailure({
              message: `rate-limit tracker mode mismatch for ${resolved}`
            })
          );
        }
        const tracker = new RateLimitTracker(resolved, mode, shared, store);
        yield* tracker.#adoptExternalState();
        return tracker;
      }
      const loaded = (yield* store.read()) ?? { state: new Map() };
      const created: SharedTrackerState = {
        mode,
        members: loaded.state,
        lastPersisted: yield* store.readText()
      };
      sharedTrackerStates.set(resolved, created);
      return new RateLimitTracker(resolved, mode, created, store);
    });
  }

  /**
   * Operators recover accounts by editing `.state.json` and reloading, so a
   * new generation must honor a file this process did not write. Shared
   * members are replaced in place to keep existing trackers consistent.
   */
  #adoptExternalState(): PersistEffect {
    const self = this;
    return Effect.gen(function* () {
      const text = yield* self.#store.readText();
      if (text === self.#shared.lastPersisted) return;
      const loaded = (yield* self.#store.read()) ?? { state: new Map() };
      self.#state.clear();
      for (const [id, member] of loaded.state) self.#state.set(id, member);
      self.#shared.lastPersisted = text;
    });
  }

  limits(memberId: string): AccountLimits | undefined {
    return this.#state.get(memberId)?.limits;
  }

  coolingUntil(memberId: string): number | undefined {
    return this.#state.get(memberId)?.coolingUntil;
  }

  cooldownRevision(memberId: string): number {
    return this.#state.get(memberId)?.cooldownRevision ?? 0;
  }

  cooldownContext(memberId: string): CooldownContext | undefined {
    return this.#state.get(memberId)?.cooldownContext;
  }

  update(memberId: string, limits: AccountLimits): PersistEffect {
    const member = this.#state.get(memberId) ?? {};
    member.limits = mergeLimits(member.limits, limits, this.#mode);
    this.#state.set(memberId, member);
    return this.#persist();
  }

  cool(memberId: string, until: number, context?: CooldownContext): PersistEffect<number> {
    const member = this.#state.get(memberId) ?? {};
    member.cooldownRevision = (member.cooldownRevision ?? 0) + 1;
    member.coolingUntil = until;
    if (context === undefined) delete member.cooldownContext;
    else member.cooldownContext = context;
    this.#state.set(memberId, member);
    const revision = member.cooldownRevision;
    return Effect.as(this.#persist(), revision);
  }

  clearCooling(memberId: string, expectedRevision?: number): PersistEffect<boolean> {
    const member = this.#state.get(memberId);
    if (
      member === undefined ||
      member.coolingUntil === undefined ||
      (expectedRevision !== undefined && member.cooldownRevision !== expectedRevision)
    ) {
      return Effect.succeed(false);
    }
    member.cooldownRevision = (member.cooldownRevision ?? 0) + 1;
    delete member.coolingUntil;
    delete member.cooldownContext;
    return Effect.as(this.#persist(), true);
  }

  reconcileSnapshot(
    memberId: string,
    limits: AccountLimits,
    expectedCooldownRevision: number,
    recovered: boolean
  ): PersistEffect<boolean> {
    const member = this.#state.get(memberId) ?? {};
    member.limits = mergeLimits(member.limits, limits, this.#mode);
    const cleared =
      recovered &&
      limits.completeness === "snapshot" &&
      member.coolingUntil !== undefined &&
      (member.cooldownRevision ?? 0) === expectedCooldownRevision;
    if (cleared) {
      member.cooldownRevision = (member.cooldownRevision ?? 0) + 1;
      delete member.coolingUntil;
      delete member.cooldownContext;
    }
    this.#state.set(memberId, member);
    return Effect.as(this.#persist(), cleared);
  }

  resetAfterRefresh(memberId: string, expectedCooldownRevision: number): PersistEffect<boolean> {
    const member = this.#state.get(memberId) ?? {};
    delete member.limits;
    const cleared = (member.cooldownRevision ?? 0) === expectedCooldownRevision;
    if (cleared) {
      member.cooldownRevision = (member.cooldownRevision ?? 0) + 1;
      delete member.coolingUntil;
      delete member.cooldownContext;
    }
    this.#state.set(memberId, member);
    return Effect.as(this.#persist(), cleared);
  }

  renameMember(sourceId: string, targetId: string): PersistEffect {
    const source = this.#state.get(sourceId);
    const removedSource = this.#state.delete(sourceId);
    const removedStaleTarget = this.#state.delete(targetId);
    if (source !== undefined) this.#state.set(targetId, source);
    if (removedSource || removedStaleTarget || source !== undefined) return this.#persist();
    return Effect.void;
  }

  #persist(): PersistEffect {
    const self = this;
    return Effect.gen(function* () {
      const text = yield* self.#store.write({ state: self.#state });
      self.#shared.lastPersisted = text;
    });
  }
}
