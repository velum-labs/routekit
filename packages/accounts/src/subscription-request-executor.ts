import { createHmac, randomBytes } from "node:crypto";

import { isRetryableProviderFailure } from "@velum-labs/routekit-contracts";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import {
  type RouteKitPlatform,
  runRouteKitEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

import { type AccountActivityCoordinator, subscriptionAccountIdentity } from "./activity.js";
import type { AccountAuthCoordinator, AuthRecoveryClaim } from "./auth-health.js";
import type { SubscriptionProvider } from "./provider.js";
import type { SubscriptionResponseMode } from "./provider-port.js";
import type { RateLimitTracker } from "./rate-limit-tracker.js";
import type {
  SubscriptionPoolMember,
  SubscriptionPoolSelector
} from "./subscription-pool-selection.js";
import {
  inspectSubscriptionResponse,
  trackSubscriptionResponseCompletion
} from "./subscription-stream.js";
import type { SubscriptionCredential, SubscriptionFailure } from "./types.js";

export type SubscriptionExecutionObserver = {
  onAttempt?(account: { seat: string }): void;
  /** Original downstream mode; providers may independently force upstream SSE. */
  responseMode?: SubscriptionResponseMode;
};

type ProbationAttempt = {
  member: SubscriptionPoolMember;
  claim: AuthRecoveryClaim;
};

export type SubscriptionRequestExecutorOptions = {
  mode: SubscriptionMode;
  members: SubscriptionPoolMember[];
  provider: SubscriptionProvider;
  tracker: RateLimitTracker;
  activity: AccountActivityCoordinator;
  authHealth: AccountAuthCoordinator;
  selector: SubscriptionPoolSelector;
  fallbackCooldownSeconds: number;
  catalogReady(): boolean;
  recoverAuthentication(
    member: SubscriptionPoolMember,
    fingerprint: string,
    model: string | undefined,
    excluded: Set<string>,
    signal?: AbortSignal
  ): Effect.Effect<AuthRecoveryClaim | undefined, Error, RouteKitPlatform>;
  finishProbationForFailure(
    claim: AuthRecoveryClaim,
    failure: SubscriptionFailure
  ): Effect.Effect<void, Error, RouteKitPlatform>;
};

export type SubscriptionRequestOperation = (
  credential: SubscriptionCredential
) => Effect.Effect<Response, Error, HttpClient.HttpClient>;

function fromPromise<A>(try_: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: try_,
    catch: toRouteKitFailure
  });
}

const ATTRIBUTION_SEAT_KEY = randomBytes(32);

function attributionSeat(label: string): string {
  return `seat_${createHmac("sha256", ATTRIBUTION_SEAT_KEY)
    .update(label)
    .digest("hex")
    .slice(0, 16)}`;
}

export class SubscriptionRequestExecutor {
  readonly #options: SubscriptionRequestExecutorOptions;

  constructor(options: SubscriptionRequestExecutorOptions) {
    this.#options = options;
  }

  execute(
    model: string | undefined,
    operation: SubscriptionRequestOperation,
    signal?: AbortSignal,
    observer?: SubscriptionExecutionObserver
  ) {
    const self = this;
    return Effect.gen(function* () {
      const {
        members,
        provider,
        tracker,
        activity,
        authHealth,
        selector,
        fallbackCooldownSeconds
      } = self.#options;
      const catalogReady = (): boolean => self.#options.catalogReady();
      if (members.length === 0) {
        return yield* Effect.fail(selector.unavailableError(model, catalogReady()));
      }
      const excluded = new Set<string>();
      const absorbed = new Set<string>();
      let transientFailovers = 0;
      let probation: ProbationAttempt | undefined;

      while (excluded.size < members.length) {
        const probationAttempt = probation;
        probation = undefined;
        if (probationAttempt === undefined) {
          const expiredBackoff = members.find((member) => {
            if (
              excluded.has(member.id) ||
              (model !== undefined && catalogReady() && !member.models.has(model))
            ) {
              return false;
            }
            const auth = authHealth.snapshot(
              subscriptionAccountIdentity(self.#options.mode, member.label),
              member.credentialFingerprint
            );
            return (
              auth.kind === "backoff" && (auth.retryAt ?? Number.POSITIVE_INFINITY) <= Date.now()
            );
          });
          if (expiredBackoff !== undefined) {
            const claim = yield* self.#options.recoverAuthentication(
              expiredBackoff,
              expiredBackoff.credentialFingerprint,
              model,
              excluded,
              signal
            );
            if (claim !== undefined) {
              probation = { member: expiredBackoff, claim };
              continue;
            }
          }
        }
        const lease =
          probationAttempt === undefined
            ? yield* selector.acquire(model, excluded, catalogReady(), signal)
            : yield* selector.acquireProbation(probationAttempt.member, signal);
        const member = lease.value;
        const attemptedFingerprint = member.credentialFingerprint;
        let handedOff = false;
        const releaseActivity = activity.beginAttempt(
          subscriptionAccountIdentity(self.#options.mode, member.label)
        );
        const release = once(() => {
          releaseActivity();
          selector.release(member);
          lease.release();
        });
        const outcome = yield* Effect.gen(function* () {
          observer?.onAttempt?.({ seat: attributionSeat(member.label) });
          const response = yield* operation(member.credential);
          const headerLimits = provider.parseLimits(response.headers);
          if (headerLimits !== undefined) yield* tracker.update(member.id, headerLimits);

          if (response.ok) {
            const inspected = yield* self.#inspectSuccessfulResponse(
              member,
              response,
              observer?.responseMode ?? "streaming",
              model,
              release,
              signal
            );
            if (inspected.failure === undefined) {
              if (probationAttempt !== undefined) {
                yield* authHealth.finishProbation(probationAttempt.claim, { kind: "accepted" });
              } else {
                authHealth.markAccepted(
                  subscriptionAccountIdentity(self.#options.mode, member.label),
                  attemptedFingerprint
                );
              }
              handedOff = true;
              return { kind: "done" as const, response: inspected.response };
            }
            const failure = inspected.failure;
            const passthrough = inspected.response;
            if (probationAttempt !== undefined) {
              yield* self.#options.finishProbationForFailure(probationAttempt.claim, failure);
            }
            if (failure.scope === "credential") {
              release();
              if (probationAttempt !== undefined) {
                excluded.add(member.id);
                return { kind: "retry" as const };
              }
              const claim = yield* self.#options.recoverAuthentication(
                member,
                attemptedFingerprint,
                model,
                excluded,
                signal
              );
              if (claim !== undefined) probation = { member, claim };
              return { kind: "retry" as const };
            }
            if (failure.scope === "member_model") {
              if (model !== undefined) member.models.delete(model);
              excluded.add(member.id);
              return { kind: "retry" as const };
            }
            if (failure.scope === "request") {
              return { kind: "done" as const, response: passthrough };
            }
            if (!isRetryableProviderFailure(failure.category)) {
              return { kind: "done" as const, response: passthrough };
            }
            if (failure.category === "transient") {
              if (!absorbed.has(member.id)) {
                absorbed.add(member.id);
                yield* Effect.sleep(`${retryDelayMs(failure.retryAfter)} millis`);
                return { kind: "retry" as const };
              }
              if (
                transientFailovers === 0 &&
                selector.hasAlternative(member, model, excluded, catalogReady())
              ) {
                transientFailovers += 1;
                excluded.add(member.id);
                return { kind: "retry" as const };
              }
              return { kind: "done" as const, response: passthrough };
            }
            yield* selector.penalize(
              member,
              cooldownUntil(failure, fallbackCooldownSeconds),
              model
            );
            excluded.add(member.id);
            return { kind: "retry" as const };
          }

          const text = yield* fromPromise(() => response.text());
          const parsed = parseJson(text);
          const bodyLimits = provider.parseLimits(response.headers, parsed);
          if (bodyLimits !== undefined) yield* tracker.update(member.id, bodyLimits);
          const failure = provider.classify(response.status, response.headers, parsed);
          const passthrough = new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
          if (probationAttempt !== undefined) {
            if (failure === undefined) {
              yield* authHealth.finishProbation(probationAttempt.claim, {
                kind: response.status >= 500 ? "inconclusive" : "accepted"
              });
            } else {
              yield* self.#options.finishProbationForFailure(probationAttempt.claim, failure);
            }
          }
          if (failure?.scope === "credential") {
            release();
            if (probationAttempt !== undefined) {
              excluded.add(member.id);
              return { kind: "retry" as const };
            }
            const claim = yield* self.#options.recoverAuthentication(
              member,
              attemptedFingerprint,
              model,
              excluded,
              signal
            );
            if (claim !== undefined) probation = { member, claim };
            return { kind: "retry" as const };
          }
          if (failure?.scope === "member_model") {
            if (model !== undefined) member.models.delete(model);
            excluded.add(member.id);
            return { kind: "retry" as const };
          }
          if (failure?.scope === "request") {
            return { kind: "done" as const, response: passthrough };
          }
          if (failure === undefined || !isRetryableProviderFailure(failure.category)) {
            return { kind: "done" as const, response: passthrough };
          }
          if (failure.category === "transient") {
            if (!absorbed.has(member.id)) {
              absorbed.add(member.id);
              yield* Effect.sleep(`${retryDelayMs(failure.retryAfter)} millis`);
              return { kind: "retry" as const };
            }
            if (
              transientFailovers === 0 &&
              selector.hasAlternative(member, model, excluded, catalogReady())
            ) {
              transientFailovers += 1;
              excluded.add(member.id);
              return { kind: "retry" as const };
            }
            return { kind: "done" as const, response: passthrough };
          }
          yield* selector.penalize(member, cooldownUntil(failure, fallbackCooldownSeconds), model);
          excluded.add(member.id);
          return { kind: "retry" as const };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!handedOff) release();
            })
          )
        );
        if (outcome.kind === "done") return outcome.response;
      }
      return yield* Effect.fail(selector.unavailableError(model, catalogReady()));
    });
  }

  #inspectSuccessfulResponse(
    member: SubscriptionPoolMember,
    response: Response,
    responseMode: SubscriptionResponseMode,
    model: string | undefined,
    release: () => void,
    signal?: AbortSignal
  ): Effect.Effect<{ response: Response; failure?: SubscriptionFailure }, Error, RouteKitPlatform> {
    const self = this;
    const { provider, tracker, authHealth, selector, fallbackCooldownSeconds } = this.#options;
    const parseStreamOutcome = provider.parseStreamOutcome;
    if (parseStreamOutcome === undefined) {
      return Effect.succeed({
        response: trackSubscriptionResponseCompletion(response, release)
      });
    }
    return Effect.gen(function* () {
      const pending: Array<Effect.Effect<void, Error, RouteKitPlatform>> = [];
      let owned = true;
      const runObserved = (effect: Effect.Effect<void, Error, RouteKitPlatform>): Promise<void> => {
        if (owned) {
          pending.push(effect);
          return Promise.resolve();
        }
        return runRouteKitEffect(effect).catch(() => undefined);
      };
      const inspected = yield* fromPromise(() =>
        inspectSubscriptionResponse({
          response,
          responseMode,
          release,
          signal,
          observe: ({ event, payload }) => {
            const limits = provider.parseStreamEvent(payload);
            if (limits !== undefined) {
              void runObserved(tracker.update(member.id, limits).pipe(Effect.ignore));
            }
            return parseStreamOutcome(event, payload);
          },
          onTerminalFailure: async (failure) => {
            if (failure.scope === "credential") {
              const fingerprint = member.credentialFingerprint;
              await runObserved(
                Effect.gen(function* () {
                  const claim = yield* self.#options.recoverAuthentication(
                    member,
                    fingerprint,
                    model,
                    new Set()
                  );
                  if (claim !== undefined) {
                    yield* authHealth.finishProbation(claim, { kind: "inconclusive" });
                  }
                }).pipe(Effect.ignore)
              );
              return;
            }
            if (!isRetryableProviderFailure(failure.category)) return;
            await runObserved(
              selector
                .penalize(member, cooldownUntil(failure, fallbackCooldownSeconds), model)
                .pipe(Effect.asVoid)
            );
          }
        })
      );
      owned = false;
      for (const effect of pending) yield* effect;
      return inspected;
    });
  }
}

function once(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function retryDelayMs(retryAfter: number | undefined): number {
  return Math.min(60, retryAfter ?? 0.5) * 1000;
}

function cooldownUntil(failure: SubscriptionFailure, fallbackCooldownSeconds: number): number {
  return failure.resetsAt ?? Date.now() / 1000 + (failure.retryAfter ?? fallbackCooldownSeconds);
}
