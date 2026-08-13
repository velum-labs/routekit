import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { Effect } from "effect";
import { type CooldownContext, RateLimitTracker } from "../rate-limit-tracker.js";
import type { AccountLimits } from "../types.js";

/**
 * Effect façade over the daemon-scoped rate-limit registry.
 *
 * Process-wide shared tracker state, external-edit adoption, and cooldown
 * revision CAS stay on `RateLimitTracker`. Overlapping generations continue
 * to share one map per state file.
 */
export class EffectRateLimitTracker {
  readonly #inner: RateLimitTracker;

  constructor(statePath: string, mode?: SubscriptionMode) {
    this.#inner = new RateLimitTracker(statePath, mode);
  }

  get inner(): RateLimitTracker {
    return this.#inner;
  }

  limits(memberId: string): Effect.Effect<AccountLimits | undefined> {
    return Effect.sync(() => this.#inner.limits(memberId));
  }

  coolingUntil(memberId: string): Effect.Effect<number | undefined> {
    return Effect.sync(() => this.#inner.coolingUntil(memberId));
  }

  cooldownRevision(memberId: string): Effect.Effect<number> {
    return Effect.sync(() => this.#inner.cooldownRevision(memberId));
  }

  cooldownContext(memberId: string): Effect.Effect<CooldownContext | undefined> {
    return Effect.sync(() => this.#inner.cooldownContext(memberId));
  }

  update(memberId: string, limits: AccountLimits): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.update(memberId, limits);
    });
  }

  cool(memberId: string, until: number, context?: CooldownContext): Effect.Effect<number> {
    return Effect.sync(() => this.#inner.cool(memberId, until, context));
  }

  clearCooling(memberId: string, expectedRevision?: number): Effect.Effect<boolean> {
    return Effect.sync(() => this.#inner.clearCooling(memberId, expectedRevision));
  }

  renameMember(sourceId: string, targetId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.renameMember(sourceId, targetId);
    });
  }
}

export function makeEffectRateLimitTracker(
  statePath: string,
  mode?: SubscriptionMode
): EffectRateLimitTracker {
  return new EffectRateLimitTracker(statePath, mode);
}
