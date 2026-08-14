import { join } from "node:path";
import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { ResourceScope } from "@velum-labs/routekit-runtime";
import {
  RouteKitFailure,
  type RouteKitPlatform,
  routeKitError,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Context, Effect } from "effect";
import { AccountCatalogService } from "./account-set/catalog-service.js";
import { ResetCreditService } from "./account-set/reset-credits.js";
import { AccountSetStatusService } from "./account-set/status-service.js";
import { resolveSubscriptionAccounts } from "./account-source.js";
import { AccountActivityCoordinator, subscriptionAccountIdentity } from "./activity.js";
import { poolReadiness, quotaAdmissionReasons } from "./admission.js";
import type { AuthRecoveryClaim } from "./auth-health.js";
import { AccountAuthCoordinator } from "./auth-health.js";
import { runCapturedPlatform } from "./captured-runtime.js";
import { subscriptionCredentialFingerprint, subscriptionCredentialLabel } from "./credentials.js";
import {
  type SubscriptionProvider,
  SubscriptionProviderRequestError,
  SubscriptionRefreshError
} from "./provider.js";
import type { CooldownContext } from "./rate-limit-tracker.js";
import { RateLimitTracker } from "./rate-limit-tracker.js";
import {
  SubscriptionAccountSetAuthError,
  SubscriptionAccountSetAuthRecoveryError,
  SubscriptionAccountSetExhaustedError,
  type SubscriptionPoolMember,
  SubscriptionPoolSelector
} from "./subscription-pool-selection.js";
import {
  type SubscriptionExecutionObserver,
  SubscriptionRequestExecutor,
  type SubscriptionRequestOperation
} from "./subscription-request-executor.js";
import { SUBSCRIPTION_SSE_BUFFER_CAP_BYTES } from "./subscription-stream.js";

export {
  SubscriptionAccountSetAuthError,
  SubscriptionAccountSetAuthRecoveryError,
  SubscriptionAccountSetExhaustedError
} from "./subscription-pool-selection.js";
export type {
  SubscriptionExecutionObserver,
  SubscriptionRequestOperation
} from "./subscription-request-executor.js";

export { SUBSCRIPTION_SSE_BUFFER_CAP_BYTES } from "./subscription-stream.js";

import type {
  AccountLimits,
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionFailure,
  SubscriptionSelectionStrategy
} from "./types.js";

export type {
  CoordinatorResource,
  RedeemResetCreditInput,
  RedeemResetCreditResult,
  SubscriptionAccountSetOptions
} from "./account-set/types.js";

import type {
  CoordinatorResource,
  RedeemResetCreditInput,
  RedeemResetCreditResult,
  SubscriptionAccountSetOptions
} from "./account-set/types.js";

type PoolMember = SubscriptionPoolMember;

const DEFAULT_SWITCH_THRESHOLD = 0.9;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;
const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 300;
const RAMP_WINDOW_MS = 30_000;
const RAMP_STEP_MS = 250;
export class SubscriptionAccountSet<M extends SubscriptionMode = SubscriptionMode> {
  readonly #provider: SubscriptionProvider<M>;
  readonly #options: Required<
    Pick<
      SubscriptionAccountSetOptions,
      "strategy" | "switchThreshold" | "refreshSkewSeconds" | "fallbackCooldownSeconds"
    >
  > &
    SubscriptionAccountSetOptions;
  readonly #members: PoolMember[];
  readonly #selector: SubscriptionPoolSelector;
  readonly #executor: SubscriptionRequestExecutor;
  readonly #tracker: RateLimitTracker;
  readonly #activity: AccountActivityCoordinator;
  readonly #metadata = new Map<string, ModelCapabilityMetadata>();
  readonly #selectionSignals = new Map<string, ModelSelectionSignals>();
  readonly #authHealth: AccountAuthCoordinator;
  readonly #resources = new ResourceScope();
  readonly #reasoning = new Map<string, ModelReasoningCapabilities>();
  readonly #resetCredits: ResetCreditService<M>;
  readonly #catalog: AccountCatalogService<M>;
  readonly #status: AccountSetStatusService<M>;
  readonly #platform: Context.Context<RouteKitPlatform>;
  #usageProbe: Promise<void> | undefined;
  #lastUsageProbeAt: number | undefined;
  #catalogReady = false;
  #probeTimer: NodeJS.Timeout | undefined;
  #closed = false;

  private constructor(
    provider: SubscriptionProvider<M>,
    options: SubscriptionAccountSetOptions,
    members: PoolMember[],
    tracker: RateLimitTracker,
    platform: Context.Context<RouteKitPlatform>
  ) {
    this.#provider = provider;
    this.#options = {
      ...options,
      strategy: options.strategy ?? "sticky",
      switchThreshold: options.switchThreshold ?? DEFAULT_SWITCH_THRESHOLD,
      refreshSkewSeconds: options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS,
      fallbackCooldownSeconds: options.fallbackCooldownSeconds ?? DEFAULT_FALLBACK_COOLDOWN_SECONDS
    };
    this.#members = members;
    this.#tracker = tracker;
    this.#platform = platform;
    this.#resetCredits = new ResetCreditService(provider, tracker);
    this.#catalog = new AccountCatalogService(
      members,
      this.#metadata,
      this.#selectionSignals,
      this.#reasoning,
      (member, signal) => Effect.asVoid(this.#ensureFresh(member, signal)),
      (member, signal) => this.#discoverMemberModels(member, signal),
      () => {
        this.#catalogReady = true;
      }
    );
    this.#activity = options.activity!.resource;
    this.#authHealth = options.authHealth!.resource;
    this.#selector = new SubscriptionPoolSelector({
      mode: provider.mode,
      members,
      tracker,
      authHealth: this.#authHealth,
      strategy: this.#options.strategy,
      switchThreshold: this.#options.switchThreshold,
      ...(this.#options.beforeAcquisitionRevalidation !== undefined
        ? { beforeAcquisitionRevalidation: this.#options.beforeAcquisitionRevalidation }
        : {}),
      synchronizeCredential: (member) => Effect.asVoid(this.#synchronizeCredential(member)),
      ensureFresh: (member, signal) => Effect.asVoid(this.#ensureFresh(member, signal)),
      waitForRamp: (member, signal) => Effect.asVoid(this.#waitForRamp(member, signal))
    });
    this.#status = new AccountSetStatusService(
      provider.mode,
      this.#options.strategy,
      this.#options.switchThreshold,
      members,
      tracker,
      this.#activity,
      this.#authHealth,
      this.#selector,
      () => this.#catalogReady
    );

    this.#executor = new SubscriptionRequestExecutor({
      mode: provider.mode,
      members,
      provider,
      tracker,
      activity: this.#activity,
      authHealth: this.#authHealth,
      selector: this.#selector,
      fallbackCooldownSeconds: this.#options.fallbackCooldownSeconds,
      catalogReady: () => this.#catalogReady,
      recoverAuthentication: (member, fingerprint, model, excluded, signal) =>
        this.#recoverAuthentication(member, fingerprint, model, excluded, signal),
      finishProbationForFailure: (claim, failure) =>
        Effect.asVoid(this.#finishProbationForFailure(claim, failure))
    });
  }

  static open<M extends SubscriptionMode>(
    provider: SubscriptionProvider<M>,
    options: SubscriptionAccountSetOptions
  ) {
    return Effect.suspend(() => {
      const resources = new ResourceScope();
      return Effect.gen(function* () {
        const platform = yield* Effect.context<RouteKitPlatform>();
        const source = options.source ?? { kind: "auto" as const };
        const accounts = yield* Effect.tryPromise({
          try: () => resolveSubscriptionAccounts(provider.mode, source),
          catch: toRouteKitFailure
        });
        const tracker = yield* RateLimitTracker.open(
          join(accounts.stateDirectory, ".state.json"),
          provider.mode
        );
        const activity =
          options.activity === undefined
            ? resources.own(yield* AccountActivityCoordinator.open())
            : options.activity.ownership === "owned"
              ? resources.own(options.activity.resource)
              : resources.borrow(options.activity.resource);
        const authHealth =
          options.authHealth === undefined
            ? resources.own(yield* AccountAuthCoordinator.open())
            : options.authHealth.ownership === "owned"
              ? resources.own(options.authHealth.resource)
              : resources.borrow(options.authHealth.resource);
        const members: PoolMember[] = [];
        for (const sourcePath of accounts.paths) {
          const credential = yield* provider
            .loadCredential(sourcePath)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (credential === undefined) {
            // A broken member remains visible on disk for `proxy status`, but is
            // excluded from serving until the operator re-enrolls it.
            continue;
          }
          const id = subscriptionCredentialLabel(sourcePath);
          const credentialFingerprint = subscriptionCredentialFingerprint(sourcePath);
          authHealth.register(
            subscriptionAccountIdentity(provider.mode, id),
            credentialFingerprint
          );
          members.push({
            id,
            label: id,
            sourcePath,
            credential,
            models: new Set(),
            ...(tracker.coolingUntil(id) !== undefined
              ? { coolingUntil: tracker.coolingUntil(id) }
              : {}),
            cooldownRevision: tracker.cooldownRevision(id),
            lastUsed: 0,
            inFlight: 0,
            switchedAt: 0,
            credentialFingerprint
          });
        }
        const accountSet = new SubscriptionAccountSet(
          provider,
          {
            ...options,
            activity: { resource: activity, ownership: "borrowed" },
            authHealth: { resource: authHealth, ownership: "borrowed" }
          },
          members,
          tracker,
          platform
        );
        resources.transferTo(accountSet.#resources);
        accountSet.#startProbe();
        return accountSet;
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise({
            try: () => resources.dispose(),
            catch: toRouteKitFailure
          }).pipe(Effect.ignore)
        )
      );
    });
  }

  get mode(): SubscriptionMode {
    return this.#provider.mode;
  }

  get size(): number {
    return this.#members.length;
  }

  snapshot(): SubscriptionAccountSetSnapshot {
    return this.#status.snapshot();
  }

  statusSnapshot(): SubscriptionAccountSetSnapshot {
    return this.#status.statusSnapshot();
  }

  discoverModels(signal?: AbortSignal) {
    return this.#catalog.discoverModels(signal);
  }

  listModelIds(): readonly string[] {
    return this.#catalog.listModelIds();
  }
  reasoningCapabilities(model: string): ModelReasoningCapabilities | undefined {
    return this.#catalog.reasoningCapabilities(model);
  }
  modelMetadata(model: string): ModelCapabilityMetadata | undefined {
    return this.#catalog.modelMetadata(model);
  }
  modelSelectionSignals(model: string): ModelSelectionSignals | undefined {
    return this.#catalog.modelSelectionSignals(model);
  }

  close() {
    const self = this;
    return Effect.suspend(() => {
      if (self.#closed) return Effect.void;
      self.#closed = true;
      if (self.#probeTimer !== undefined) {
        clearInterval(self.#probeTimer);
        self.#probeTimer = undefined;
      }
      const inFlight = self.#usageProbe;
      return Effect.gen(function* () {
        if (inFlight !== undefined) {
          yield* Effect.tryPromise({
            try: () => inFlight,
            catch: toRouteKitFailure
          }).pipe(Effect.ignore);
        }
        yield* Effect.tryPromise({
          try: () => self.#resources.dispose(),
          catch: toRouteKitFailure
        });
      });
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await runCapturedPlatform(this.#platform, this.close());
  }

  probe(signal?: AbortSignal) {
    const self = this;
    return Effect.all(
      this.#members.map((member) =>
        Effect.gen(function* () {
          yield* self.#ensureFresh(member, signal);
          const cooldownRevision = member.cooldownRevision;
          const cooldownContext = self.#tracker.cooldownContext(member.id);
          const limits = yield* self.#fetchUsageWithAuthRecovery(member, signal);
          const withResets = yield* self.#attachResetCredits(member, limits, signal);
          const recovered = self.#snapshotRecovered(withResets, cooldownContext);
          yield* self.#tracker.reconcileSnapshot(
            member.id,
            withResets,
            cooldownRevision,
            recovered
          );
          member.coolingUntil = self.#tracker.coolingUntil(member.id);
          member.cooldownRevision = self.#tracker.cooldownRevision(member.id);
        }).pipe(Effect.ignore)
      ),
      { concurrency: "unbounded" }
    ).pipe(Effect.asVoid);
  }

  /** List banked rate-limit reset credits for one enrolled member. */
  listResetCredits(label: string, signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      const member = self.#requireMember(label);
      yield* self.#ensureFresh(member, signal);
      return yield* self.#resetCredits.list(member, signal);
    });
  }

  /** Redeem one banked rate-limit reset for an enrolled member. */
  redeemResetCredit(input: RedeemResetCreditInput, signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      const member = self.#requireMember(input.label);
      yield* self.#ensureFresh(member, signal);
      return yield* self.#resetCredits.redeem(
        input,
        member,
        (m, s) => self.#fetchUsageWithAuthRecovery(m, s),
        signal
      );
    });
  }

  /**
   * Refresh stale or missing usage without allowing rapid callers to hammer
   * provider quota endpoints. Failed attempts are throttled as well.
   */
  refreshUsage(maxAgeMs = 60_000, signal?: AbortSignal) {
    const self = this;
    return Effect.suspend(() => {
      if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
        return Effect.fail(
          new RouteKitFailure({
            message: "usage refresh age must be a non-negative finite number"
          })
        );
      }
      if (self.#members.length === 0) return Effect.void;
      const now = Date.now();
      const allFresh = self.#members.every((member) => {
        const limits = self.#tracker.limits(member.id);
        return limits?.completeness === "snapshot" && now - limits.observedAt * 1000 < maxAgeMs;
      });
      if (allFresh) return Effect.void;
      if (self.#usageProbe !== undefined) {
        return Effect.tryPromise({
          try: () => self.#usageProbe!,
          catch: toRouteKitFailure
        });
      }
      if (self.#lastUsageProbeAt !== undefined && now - self.#lastUsageProbeAt < maxAgeMs) {
        return Effect.void;
      }
      self.#lastUsageProbeAt = now;
      let settled = false;
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolveLatch();
        else rejectLatch(error);
      };
      let resolveLatch!: () => void;
      let rejectLatch!: (error: unknown) => void;
      const probe = new Promise<void>((resolve, reject) => {
        resolveLatch = resolve;
        rejectLatch = reject;
      });
      self.#usageProbe = probe;
      return self.probe(signal).pipe(
        Effect.tap(() => Effect.sync(() => settle())),
        Effect.tapError((error) => Effect.sync(() => settle(error))),
        Effect.ensuring(
          Effect.sync(() => {
            settle();
            if (self.#usageProbe === probe) self.#usageProbe = undefined;
          })
        )
      );
    });
  }

  execute(
    model: string | undefined,
    operation: SubscriptionRequestOperation,
    signal?: AbortSignal,
    observer?: SubscriptionExecutionObserver
  ) {
    return this.#executor
      .execute(model, operation, signal, observer)
      .pipe(Effect.mapError((error) => (error instanceof Error ? error : routeKitError(error))));
  }
  #requireMember(label: string): PoolMember {
    const normalized = label.trim();
    if (normalized.length === 0) {
      throw new Error("account label is required");
    }
    const member = this.#members.find((candidate) => candidate.label === normalized);
    if (member === undefined) {
      throw new Error(`${this.mode}/${normalized} is not enrolled`);
    }
    return member;
  }

  #attachResetCredits(member: PoolMember, limits: AccountLimits, signal?: AbortSignal) {
    return this.#resetCredits.attach(member, limits, signal);
  }

  #synchronizeCredential(member: PoolMember) {
    const self = this;
    return Effect.gen(function* () {
      const identity = subscriptionAccountIdentity(self.mode, member.label);
      const snapshot = self.#authHealth.snapshot(identity, member.credentialFingerprint);
      if (snapshot.kind !== "superseded") return;
      const fingerprint = subscriptionCredentialFingerprint(member.sourcePath);
      if (fingerprint !== snapshot.currentFingerprint) return;
      member.credential = yield* self.#provider.loadCredential(member.sourcePath);
      member.credentialFingerprint = fingerprint;
      self.#authHealth.register(identity, fingerprint);
    });
  }

  #recoverAuthentication(
    member: PoolMember,
    fingerprint: string,
    model: string | undefined,
    excluded: Set<string>,
    signal?: AbortSignal
  ) {
    const self = this;
    return Effect.gen(function* () {
      const identity = subscriptionAccountIdentity(self.mode, member.label);
      const recovery = self.#authHealth.beginRecovery(identity, fingerprint);
      if (recovery.role === "superseded") {
        yield* self.#synchronizeCredential(member);
        return undefined;
      }
      if (recovery.role === "blocked") {
        excluded.add(member.id);
        return undefined;
      }
      if (recovery.role === "waiter") {
        const now = Date.now() / 1000;
        const hasAlternative = self.#members.some(
          (candidate) =>
            candidate.id !== member.id &&
            !excluded.has(candidate.id) &&
            self.#selector.eligible(candidate, model, self.#catalogReady, now)
        );
        if (hasAlternative) {
          excluded.add(member.id);
          return undefined;
        }
        const outcome = yield* self.#awaitAbortably(recovery.completion, signal);
        if (outcome.kind === "backoff" || outcome.kind === "rejected") excluded.add(member.id);
        return undefined;
      }

      const expectedCooldownRevision = self.#tracker.cooldownRevision(member.id);
      const refreshSignal = AbortSignal.any([self.#authHealth.signal, AbortSignal.timeout(30_000)]);
      return yield* self.#provider.refresh(member.credential, refreshSignal).pipe(
        Effect.flatMap((credential) =>
          Effect.gen(function* () {
            const refreshedFingerprint = subscriptionCredentialFingerprint(member.sourcePath);
            if (!(yield* self.#authHealth.markRefreshed(recovery.claim, refreshedFingerprint))) {
              yield* self.#synchronizeCredential(member);
              return undefined;
            }
            member.credential = credential;
            member.credentialFingerprint = refreshedFingerprint;
            if (yield* self.#tracker.resetAfterRefresh(member.id, expectedCooldownRevision)) {
              delete member.coolingUntil;
            } else {
              member.coolingUntil = self.#tracker.coolingUntil(member.id);
            }
            member.cooldownRevision = self.#tracker.cooldownRevision(member.id);
            if (signal?.aborted === true) {
              yield* self.#authHealth.finishProbation(recovery.claim, { kind: "inconclusive" });
              signal.throwIfAborted();
            }
            return recovery.claim;
          })
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error instanceof SubscriptionRefreshError) {
              yield* self.#authHealth.failRefresh(recovery.claim, error.failure);
            } else {
              yield* self.#authHealth.failRefresh(recovery.claim, {
                kind: "transient",
                failureKind: "network"
              });
            }
            if (signal?.aborted === true) signal.throwIfAborted();
            excluded.add(member.id);
            return undefined;
          })
        )
      );
    });
  }

  #finishProbationForFailure(claim: AuthRecoveryClaim, failure: SubscriptionFailure) {
    const self = this;
    return Effect.gen(function* () {
      if (failure.scope === "credential" && (failure.status === 401 || failure.status === 403)) {
        yield* self.#authHealth.finishProbation(claim, {
          kind: "rejected",
          status: failure.status,
          reasonCode: self.#authReasonCode(failure)
        });
        return;
      }
      if (
        failure.category === "quota_exhausted" ||
        failure.scope === "member_model" ||
        failure.scope === "request"
      ) {
        yield* self.#authHealth.finishProbation(claim, { kind: "accepted" });
        return;
      }
      yield* self.#authHealth.finishProbation(claim, { kind: "inconclusive" });
    });
  }

  #awaitAbortably<T>(promise: Promise<T>, signal?: AbortSignal) {
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

  #authReasonCode(failure: SubscriptionFailure): string {
    const identifier = (failure.code ?? failure.type)?.toLowerCase();
    switch (identifier) {
      case "authentication_error":
      case "invalid_token":
      case "invalidated_token":
      case "oauth_token_invalid":
      case "token_revoked":
      case "revoked_token":
      case "unauthorized":
        return identifier;
      default:
        return "upstream_auth_rejected";
    }
  }

  #snapshotRecovered(limits: AccountLimits, context: CooldownContext | undefined): boolean {
    if (limits.completeness !== "snapshot") return false;
    const relevant = (key: string, limitName?: string): boolean => {
      if (context?.windows !== undefined && context.windows.length > 0) {
        return context.windows.includes(key);
      }
      if (context?.model === undefined) return true;
      return this.#selector.windowRelevant(key, limitName, context.model);
    };
    return (
      quotaAdmissionReasons({
        limits,
        switchThreshold: this.#options.switchThreshold,
        isWindowRelevant: relevant
      }).length === 0
    );
  }

  /**
   * A member keeps its previous catalog when discovery fails, because an empty
   * model set makes it pool-ineligible: a provider blip would otherwise take
   * every account dark until discovery succeeds again.
   */
  #discoverMemberModels(member: PoolMember, signal?: AbortSignal) {
    const self = this;
    return self.#provider.discoverModels(member.credential, signal).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          self.#authHealth.markAccepted(
            subscriptionAccountIdentity(self.mode, member.label),
            member.credentialFingerprint
          );
        })
      ),
      Effect.catch((error) => {
        if (
          !(error instanceof SubscriptionProviderRequestError) ||
          error.failure.scope !== "credential"
        ) {
          return Effect.fail(error);
        }
        return Effect.gen(function* () {
          const claim = yield* self.#recoverAuthentication(
            member,
            member.credentialFingerprint,
            undefined,
            new Set(),
            signal
          );
          if (claim === undefined) return yield* Effect.fail(error);
          return yield* self.#provider.discoverModels(member.credential, signal).pipe(
            Effect.tap(() => self.#authHealth.finishProbation(claim, { kind: "accepted" })),
            Effect.catch((retryError) =>
              Effect.gen(function* () {
                if (
                  retryError instanceof SubscriptionProviderRequestError &&
                  retryError.failure.scope === "credential" &&
                  (retryError.failure.status === 401 || retryError.failure.status === 403)
                ) {
                  yield* self.#authHealth.finishProbation(claim, {
                    kind: "rejected",
                    status: retryError.failure.status,
                    reasonCode: self.#authReasonCode(retryError.failure)
                  });
                } else {
                  yield* self.#authHealth.finishProbation(claim, { kind: "inconclusive" });
                }
                return yield* Effect.fail(retryError);
              })
            )
          );
        });
      })
    );
  }

  #fetchUsageWithAuthRecovery(member: PoolMember, signal?: AbortSignal) {
    const self = this;
    return self.#provider.fetchUsage(member.credential, signal).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          self.#authHealth.markAccepted(
            subscriptionAccountIdentity(self.mode, member.label),
            member.credentialFingerprint
          );
        })
      ),
      Effect.catch((error) => {
        if (
          !(error instanceof SubscriptionProviderRequestError) ||
          error.failure.scope !== "credential"
        ) {
          return Effect.fail(error);
        }
        return Effect.gen(function* () {
          const claim = yield* self.#recoverAuthentication(
            member,
            member.credentialFingerprint,
            undefined,
            new Set(),
            signal
          );
          if (claim === undefined) return yield* Effect.fail(error);
          return yield* self.#provider.fetchUsage(member.credential, signal).pipe(
            Effect.tap(() => self.#authHealth.finishProbation(claim, { kind: "accepted" })),
            Effect.catch((retryError) =>
              Effect.gen(function* () {
                if (
                  retryError instanceof SubscriptionProviderRequestError &&
                  retryError.failure.scope === "credential" &&
                  (retryError.failure.status === 401 || retryError.failure.status === 403)
                ) {
                  yield* self.#authHealth.finishProbation(claim, {
                    kind: "rejected",
                    status: retryError.failure.status,
                    reasonCode: self.#authReasonCode(retryError.failure)
                  });
                } else {
                  yield* self.#authHealth.finishProbation(claim, { kind: "inconclusive" });
                }
                return yield* Effect.fail(retryError);
              })
            )
          );
        });
      })
    );
  }

  #ensureFresh(member: PoolMember, signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#synchronizeCredential(member);
      const expiresAt = member.credential.expiresAt;
      if (
        expiresAt === undefined ||
        expiresAt - Date.now() / 1000 > self.#options.refreshSkewSeconds
      ) {
        return;
      }
      const excluded = new Set<string>();
      const claim = yield* self.#recoverAuthentication(
        member,
        member.credentialFingerprint,
        undefined,
        excluded,
        signal
      );
      if (claim !== undefined) {
        yield* self.#authHealth.finishProbation(claim, { kind: "inconclusive" });
        return;
      }
      const state = self.#authHealth.snapshot(
        subscriptionAccountIdentity(self.mode, member.label),
        member.credentialFingerprint
      );
      if (state.kind === "accepted" || state.kind === "unknown") return;
      return yield* Effect.fail(self.#selector.unavailableError(undefined, self.#catalogReady));
    });
  }

  #waitForRamp(member: PoolMember, signal?: AbortSignal) {
    return Effect.gen(function* () {
      for (;;) {
        const elapsed = Date.now() - member.switchedAt;
        if (elapsed >= RAMP_WINDOW_MS) return;
        const cap = 1 + Math.floor(elapsed / RAMP_STEP_MS);
        if (member.inFlight < cap) return;
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
              }, RAMP_STEP_MS);
              const abort = (): void => {
                clearTimeout(timer);
                reject(routeKitError(signal?.reason ?? "account operation aborted"));
              };
              signal?.addEventListener("abort", abort, { once: true });
            }),
          catch: toRouteKitFailure
        });
      }
    });
  }

  #startProbe(): void {
    const interval = this.#options.probeIntervalMs ?? 0;
    if (interval <= 0) return;
    this.#probeTimer = setInterval(
      () => {
        void runCapturedPlatform(this.#platform, this.refreshUsage(0));
      },
      Math.max(60_000, interval)
    );
    this.#probeTimer.unref();
    void runCapturedPlatform(this.#platform, this.refreshUsage(0));
  }
}
