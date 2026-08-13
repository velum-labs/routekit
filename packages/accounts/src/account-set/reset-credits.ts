import { randomUUID } from "node:crypto";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import type { SubscriptionProvider } from "../provider.js";
import type { RateLimitTracker } from "../rate-limit-tracker.js";
import type { SubscriptionPoolMember } from "../subscription-pool-selection.js";
import type { AccountLimits, ResetCreditSnapshot } from "../types.js";
import type { RedeemResetCreditInput, RedeemResetCreditResult } from "./types.js";

export class ResetCreditService<M extends SubscriptionMode> {
  constructor(
    private readonly provider: SubscriptionProvider<M>,
    private readonly tracker: RateLimitTracker
  ) {}

  async list(member: SubscriptionPoolMember, signal?: AbortSignal): Promise<ResetCreditSnapshot> {
    if (this.provider.fetchResetCredits === undefined) {
      throw new Error(`${this.provider.mode} does not support redeemable rate-limit resets`);
    }
    const resetCredits = await runRouteKitEffect(
      this.provider.fetchResetCredits(member.credential, signal)
    );
    const previous = this.tracker.limits(member.id);
    await runRouteKitEffect(
      this.tracker.update(member.id, {
        ...(previous ?? {
          windows: {},
          source: "usage" as const,
          completeness: "partial" as const
        }),
        resetCredits,
        observedAt: previous?.observedAt ?? resetCredits.observedAt
      })
    );
    return resetCredits;
  }

  async attach(
    member: SubscriptionPoolMember,
    limits: AccountLimits,
    signal?: AbortSignal
  ): Promise<AccountLimits> {
    if (this.provider.fetchResetCredits === undefined) return limits;
    try {
      return {
        ...limits,
        resetCredits: await runRouteKitEffect(
          this.provider.fetchResetCredits(member.credential, signal)
        )
      };
    } catch {
      const previous = this.tracker.limits(member.id)?.resetCredits;
      return previous === undefined ? limits : { ...limits, resetCredits: previous };
    }
  }

  async redeem(
    input: RedeemResetCreditInput,
    member: SubscriptionPoolMember,
    fetchUsage: (member: SubscriptionPoolMember, signal?: AbortSignal) => Promise<AccountLimits>,
    signal?: AbortSignal
  ): Promise<RedeemResetCreditResult> {
    if (this.provider.consumeResetCredit === undefined) {
      throw new Error(`${this.provider.mode} does not support redeemable rate-limit resets`);
    }
    const expectedCooldownRevision = this.tracker.cooldownRevision(member.id);
    const redeemRequestId = input.redeemRequestId?.trim() || randomUUID();
    let creditId = input.creditId?.trim();
    if (creditId !== undefined && creditId.length === 0)
      throw new Error("creditId must not be empty");
    if (creditId === undefined) {
      const listed = await this.list(member, signal);
      const available = (listed.credits ?? []).filter((credit) => {
        const status = credit.status?.toLowerCase();
        return status === undefined || status === "available" || status === "active";
      });
      if (available.length === 0 && listed.availableCount === 0) {
        throw new Error(
          `${this.provider.mode}/${member.label} has no redeemable rate-limit resets`
        );
      }
      const pick = [...available].sort(
        (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)
      )[0];
      creditId = pick?.id;
    }
    const result = await runRouteKitEffect(
      this.provider.consumeResetCredit(
        member.credential,
        {
          redeemRequestId,
          ...(creditId !== undefined ? { creditId } : {})
        },
        signal
      )
    );
    if (result.ok) {
      try {
        const limits = await fetchUsage(member, signal);
        const withResets = await this.attach(member, limits, signal);
        await runRouteKitEffect(this.tracker.update(member.id, withResets));
      } catch {
        // Consume succeeded; local cooling is still cleared below.
      }
      if (await runRouteKitEffect(this.tracker.clearCooling(member.id, expectedCooldownRevision))) {
        delete member.coolingUntil;
      } else {
        member.coolingUntil = this.tracker.coolingUntil(member.id);
      }
      member.cooldownRevision = this.tracker.cooldownRevision(member.id);
    }
    return {
      ...result,
      label: member.label,
      mode: this.provider.mode,
      ...(creditId !== undefined && result.creditId === undefined ? { creditId } : {})
    };
  }
}
