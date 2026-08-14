import { ProviderFailureError } from "@velum-labs/routekit-contracts";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { type CapacityLease, CapacityPool } from "@velum-labs/routekit-runtime";
import {
  type RouteKitPlatform,
  routeKitError,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { subscriptionAccountIdentity } from "./activity.js";
import {
  hasUsableCredits,
  isOverSwitchThreshold,
  isPoolEligible,
  memberHeadroom
} from "./admission.js";
import type { AccountAuthCoordinator } from "./auth-health.js";
import type { RateLimitTracker } from "./rate-limit-tracker.js";
import type { SubscriptionCredential, SubscriptionSelectionStrategy } from "./types.js";

export type SubscriptionPoolMember = {
  id: string;
  label: string;
  sourcePath: string;
  credential: SubscriptionCredential;
  models: Set<string>;
  coolingUntil?: number;
  cooldownRevision: number;
  lastUsed: number;
  inFlight: number;
  switchedAt: number;
  credentialFingerprint: string;
};

export class SubscriptionAccountSetExhaustedError extends ProviderFailureError {
  readonly resetAt: number | undefined;

  constructor(mode: SubscriptionMode, resetAt?: number) {
    const message =
      resetAt === undefined
        ? `all ${mode} subscription pool members are unavailable`
        : `all ${mode} subscription pool members are unavailable until ${new Date(resetAt * 1000).toISOString()}`;
    super({
      category: "quota_exhausted",
      message,
      ...(resetAt !== undefined ? { resetsAt: resetAt } : {})
    });
    this.resetAt = resetAt;
  }
}

export class SubscriptionAccountSetAuthError extends ProviderFailureError {
  constructor(mode: SubscriptionMode) {
    super({
      category: "auth_permanent",
      status: 401,
      message:
        `all ${mode} subscription pool members were rejected by upstream authentication; ` +
        `run \`routekit accounts status\`, then remove and re-login each rejected ${mode} account`
    });
  }
}

export class SubscriptionAccountSetAuthRecoveryError extends ProviderFailureError {
  constructor(mode: SubscriptionMode, retryAt: number) {
    super({
      category: "auth_transient",
      message: `all ${mode} subscription pool members are waiting for authentication recovery`,
      retryAfter: Math.max(0, retryAt - Date.now() / 1000)
    });
  }
}

export type SubscriptionPoolSelectorOptions = {
  mode: SubscriptionMode;
  members: SubscriptionPoolMember[];
  tracker: RateLimitTracker;
  authHealth: AccountAuthCoordinator;
  strategy: SubscriptionSelectionStrategy;
  switchThreshold: number;
  beforeAcquisitionRevalidation?: (member: { label: string }) => Promise<void>;
  synchronizeCredential(
    member: SubscriptionPoolMember
  ): Effect.Effect<void, Error, RouteKitPlatform> | undefined;
  ensureFresh(
    member: SubscriptionPoolMember,
    signal?: AbortSignal
  ): Effect.Effect<void, Error, RouteKitPlatform>;
  waitForRamp(
    member: SubscriptionPoolMember,
    signal?: AbortSignal
  ): Effect.Effect<void, Error, RouteKitPlatform>;
};

export class SubscriptionPoolSelector {
  readonly #options: SubscriptionPoolSelectorOptions;
  readonly #capacityPool: CapacityPool<SubscriptionPoolMember> | undefined;
  #activeId: string | undefined;

  constructor(options: SubscriptionPoolSelectorOptions) {
    this.#options = options;
    this.#capacityPool =
      options.members.length === 0
        ? undefined
        : new CapacityPool(
            options.members.map((member) => ({ id: member.id, value: member })),
            { strategy: options.strategy }
          );
  }

  acquire(
    model: string | undefined,
    excluded: Set<string>,
    catalogReady: boolean,
    signal?: AbortSignal
  ): Effect.Effect<CapacityLease<SubscriptionPoolMember>, Error, RouteKitPlatform> {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.all(
        self.#options.members.flatMap((member) => {
          const synchronization = self.#options.synchronizeCredential(member);
          return synchronization === undefined ? [] : [synchronization];
        }),
        { concurrency: "unbounded" }
      );
      const now = Date.now() / 1000;
      yield* self.#clearExpiredCooldowns(now);
      const eligible = self.#options.members.filter(
        (member) => !excluded.has(member.id) && self.eligible(member, model, catalogReady, now)
      );
      if (eligible.length === 0) {
        const activeRecovery = self.#options.members
          .filter(
            (member) =>
              !excluded.has(member.id) &&
              (model === undefined || !catalogReady || member.models.has(model))
          )
          .map((member) =>
            self.#options.authHealth.completion(
              subscriptionAccountIdentity(self.#options.mode, member.label),
              member.credentialFingerprint
            )
          )
          .find((completion) => completion !== undefined);
        if (activeRecovery !== undefined) {
          yield* awaitAbortably(activeRecovery, signal);
          return yield* self.acquire(model, excluded, catalogReady, signal);
        }
        return yield* Effect.fail(self.unavailableError(model, catalogReady));
      }
      const ineligible = new Set([
        ...excluded,
        ...self.#options.members
          .filter((member) => !eligible.includes(member))
          .map((member) => member.id)
      ]);
      if (self.#capacityPool === undefined) {
        return yield* Effect.fail(new SubscriptionAccountSetExhaustedError(self.#options.mode));
      }
      for (const member of self.#options.members) {
        self.#capacityPool.update(member.id, {
          quotaUtilization: self.#quotaUtilization(member, model),
          ...(member.coolingUntil !== undefined
            ? { coolingUntil: member.coolingUntil * 1000 }
            : { coolingUntil: undefined })
        });
      }
      const lease = yield* self.#capacityPool
        .acquire(model ?? "default", ineligible)
        .pipe(Effect.mapError(() => new SubscriptionAccountSetExhaustedError(self.#options.mode)));
      const member = lease.value;
      return yield* Effect.gen(function* () {
        yield* self.#options.ensureFresh(member, signal);
        if (self.#activeId !== member.id) {
          self.#activeId = member.id;
          member.switchedAt = Date.now();
        }
        yield* self.#options.waitForRamp(member, signal);
        // Return to the event loop so a concurrent acquire can pass ramp
        // before this caller increments inFlight.
        yield* Effect.tryPromise({
          try: () => Promise.resolve(),
          catch: toRouteKitFailure
        });
        if (self.#options.beforeAcquisitionRevalidation !== undefined) {
          yield* Effect.tryPromise({
            try: () => self.#options.beforeAcquisitionRevalidation!({ label: member.label }),
            catch: toRouteKitFailure
          });
        }
        const revalidatedAt = Date.now() / 1000;
        if (excluded.has(member.id) || !self.eligible(member, model, catalogReady, revalidatedAt)) {
          lease.release();
          return yield* self.acquire(model, excluded, catalogReady, signal);
        }
        member.inFlight += 1;
        member.lastUsed = Date.now();
        return lease;
      }).pipe(
        Effect.catch((error) => {
          lease.release();
          const retryAt = Date.now() / 1000;
          if (
            !excluded.has(member.id) &&
            !self.eligible(member, model, catalogReady, retryAt) &&
            self.hasAlternative(member, model, excluded, catalogReady, retryAt)
          ) {
            excluded.add(member.id);
            return self.acquire(model, excluded, catalogReady, signal);
          }
          return Effect.fail(error);
        })
      );
    }).pipe(Effect.mapError((error) => (error instanceof Error ? error : routeKitError(error))));
  }

  acquireProbation(member: SubscriptionPoolMember, signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      if (signal?.aborted) {
        return yield* Effect.fail(routeKitError(signal.reason ?? "account operation aborted"));
      }
      if (self.#capacityPool === undefined) {
        return yield* Effect.fail(new SubscriptionAccountSetExhaustedError(self.#options.mode));
      }
      const excluded = new Set(
        self.#options.members
          .filter((candidate) => candidate.id !== member.id)
          .map((candidate) => candidate.id)
      );
      const lease = yield* self.#capacityPool
        .acquire("auth-probation", excluded)
        .pipe(Effect.mapError(() => new SubscriptionAccountSetExhaustedError(self.#options.mode)));
      member.inFlight += 1;
      member.lastUsed = Date.now();
      return lease;
    });
  }

  release(member: SubscriptionPoolMember): void {
    member.inFlight = Math.max(0, member.inFlight - 1);
  }

  eligible(
    member: SubscriptionPoolMember,
    model: string | undefined,
    catalogReady: boolean,
    now: number
  ): boolean {
    const auth = this.#options.authHealth.snapshot(
      subscriptionAccountIdentity(this.#options.mode, member.label),
      member.credentialFingerprint
    );
    if (auth.kind === "superseded" || auth.kind === "refreshing" || auth.kind === "rejected") {
      return false;
    }
    if (auth.kind === "backoff") return false;
    return isPoolEligible({
      limits: this.#options.tracker.limits(member.id),
      switchThreshold: this.#options.switchThreshold,
      ...(member.coolingUntil !== undefined ? { coolingUntil: member.coolingUntil } : {}),
      ...(member.credential.expiresAt !== undefined
        ? { credentialExpiresAt: member.credential.expiresAt }
        : {}),
      hasRefreshToken: member.credential.refreshToken !== undefined,
      catalogReady,
      models: [...member.models],
      ...(model !== undefined ? { model } : {}),
      now,
      isWindowRelevant: (key, limitName) => this.windowRelevant(key, limitName, model)
    });
  }

  hasAlternative(
    member: SubscriptionPoolMember,
    model: string | undefined,
    excluded: Set<string>,
    catalogReady: boolean,
    now = Date.now() / 1000
  ): boolean {
    return this.#options.members.some(
      (candidate) =>
        candidate.id !== member.id &&
        !excluded.has(candidate.id) &&
        this.eligible(candidate, model, catalogReady, now)
    );
  }

  windowRelevant(key: string, limitName: string | undefined, model: string | undefined): boolean {
    const lowered = (model ?? "").toLowerCase();
    const descriptor = `${key} ${limitName ?? ""}`.toLowerCase();
    for (const family of ["sonnet", "opus", "haiku", "spark"]) {
      if (descriptor.includes(family)) return lowered.includes(family);
    }
    return true;
  }

  penalize(member: SubscriptionPoolMember, until: number, model: string | undefined) {
    const self = this;
    return Effect.gen(function* () {
      member.coolingUntil = until;
      const limits = self.#options.tracker.limits(member.id);
      const windows =
        limits === undefined
          ? undefined
          : Object.entries(limits.windows)
              .filter(([key, window]) => self.windowRelevant(key, window.limitName, model))
              .map(([key]) => key);
      member.cooldownRevision = yield* self.#options.tracker.cool(member.id, until, {
        ...(model !== undefined ? { model } : {}),
        ...(windows !== undefined && windows.length > 0 ? { windows } : {})
      });
      if (self.#activeId === member.id) self.#activeId = undefined;
    });
  }

  unavailableError(model: string | undefined, catalogReady: boolean): ProviderFailureError {
    const relevant = this.#options.members.filter(
      (member) => model === undefined || !catalogReady || member.models.has(model)
    );
    const auth = relevant.map((member) =>
      this.#options.authHealth.snapshot(
        subscriptionAccountIdentity(this.#options.mode, member.label),
        member.credentialFingerprint
      )
    );
    const backoffs = auth.flatMap((snapshot) =>
      snapshot.kind === "backoff" && snapshot.retryAt !== undefined ? [snapshot.retryAt] : []
    );
    const authRetryAt = backoffs.length === 0 ? undefined : Math.min(...backoffs) / 1000;
    const quotaResetAt = this.#soonestReset(model, catalogReady);
    if (authRetryAt !== undefined && (quotaResetAt === undefined || authRetryAt < quotaResetAt)) {
      return new SubscriptionAccountSetAuthRecoveryError(this.#options.mode, authRetryAt);
    }
    if (relevant.length > 0 && auth.every((snapshot) => snapshot.kind === "rejected")) {
      return new SubscriptionAccountSetAuthError(this.#options.mode);
    }
    return new SubscriptionAccountSetExhaustedError(this.#options.mode, quotaResetAt);
  }

  #clearExpiredCooldowns(now: number) {
    const self = this;
    return Effect.gen(function* () {
      for (const member of self.#options.members) {
        if (member.coolingUntil === undefined || member.coolingUntil > now) continue;
        if (yield* self.#options.tracker.clearCooling(member.id, member.cooldownRevision)) {
          delete member.coolingUntil;
          member.cooldownRevision = self.#options.tracker.cooldownRevision(member.id);
        } else {
          member.coolingUntil = self.#options.tracker.coolingUntil(member.id);
          member.cooldownRevision = self.#options.tracker.cooldownRevision(member.id);
        }
      }
    });
  }

  #headroom(member: SubscriptionPoolMember, model: string | undefined): number {
    return memberHeadroom(this.#options.tracker.limits(member.id), (key, limitName) =>
      this.windowRelevant(key, limitName, model)
    );
  }

  #quotaUtilization(member: SubscriptionPoolMember, model: string | undefined): number {
    const headroom = this.#headroom(member, model);
    const utilization = 1 - headroom;
    if (
      isOverSwitchThreshold(headroom, this.#options.switchThreshold) &&
      hasUsableCredits(this.#options.tracker.limits(member.id)?.credits)
    ) {
      return Math.min(utilization, this.#options.switchThreshold);
    }
    return utilization;
  }

  #soonestReset(model: string | undefined, catalogReady: boolean): number | undefined {
    const now = Date.now() / 1000;
    const resets: number[] = [];
    for (const member of this.#options.members) {
      if (!this.eligible(member, model, catalogReady, now)) {
        if (member.coolingUntil !== undefined && member.coolingUntil > now) {
          resets.push(member.coolingUntil);
        }
        const limits = this.#options.tracker.limits(member.id);
        if (limits === undefined) continue;
        for (const [key, window] of Object.entries(limits.windows)) {
          if (
            window.resetsAt !== undefined &&
            window.resetsAt > now &&
            this.windowRelevant(key, window.limitName, model) &&
            isOverSwitchThreshold(
              memberHeadroom(limits, (candidateKey, limitName) =>
                this.windowRelevant(candidateKey, limitName, model)
              ),
              this.#options.switchThreshold
            ) &&
            !hasUsableCredits(limits.credits)
          ) {
            resets.push(window.resetsAt);
          }
        }
      }
    }
    return resets.length > 0 ? Math.min(...resets) : undefined;
  }
}

function awaitAbortably<T>(promise: Promise<T>, signal?: AbortSignal) {
  return Effect.tryPromise({
    try: async () => {
      if (signal === undefined) return await promise;
      signal.throwIfAborted();
      return await new Promise<T>((resolve, reject) => {
        const abort = (): void =>
          reject(routeKitError(signal.reason ?? "account operation aborted"));
        signal.addEventListener("abort", abort, { once: true });
        promise.then(
          (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          }
        );
      });
    },
    catch: toRouteKitFailure
  });
}
