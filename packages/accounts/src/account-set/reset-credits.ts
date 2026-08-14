import { randomUUID } from "node:crypto";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { RouteKitFailure, type RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { SubscriptionProvider } from "../provider.js";
import type { RateLimitTracker } from "../rate-limit-tracker.js";
import type { SubscriptionPoolMember } from "../subscription-pool-selection.js";
import type { AccountLimits } from "../types.js";
import type { RedeemResetCreditInput } from "./types.js";

export class ResetCreditService<M extends SubscriptionMode> {
  constructor(
    private readonly provider: SubscriptionProvider<M>,
    private readonly tracker: RateLimitTracker
  ) {}

  list(member: SubscriptionPoolMember, signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      if (self.provider.fetchResetCredits === undefined) {
        return yield* Effect.fail(
          new RouteKitFailure({
            message: `${self.provider.mode} does not support redeemable rate-limit resets`
          })
        );
      }
      const resetCredits = yield* self.provider.fetchResetCredits(member.credential, signal);
      const previous = self.tracker.limits(member.id);
      yield* self.tracker.update(member.id, {
        ...(previous ?? {
          windows: {},
          source: "usage" as const,
          completeness: "partial" as const
        }),
        resetCredits,
        observedAt: previous?.observedAt ?? resetCredits.observedAt
      });
      return resetCredits;
    });
  }

  attach(member: SubscriptionPoolMember, limits: AccountLimits, signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      if (self.provider.fetchResetCredits === undefined) return limits;
      return yield* self.provider.fetchResetCredits(member.credential, signal).pipe(
        Effect.map((resetCredits) => ({ ...limits, resetCredits })),
        Effect.catch(() => {
          const previous = self.tracker.limits(member.id)?.resetCredits;
          return Effect.succeed(
            previous === undefined ? limits : { ...limits, resetCredits: previous }
          );
        })
      );
    });
  }

  redeem(
    input: RedeemResetCreditInput,
    member: SubscriptionPoolMember,
    fetchUsage: (
      member: SubscriptionPoolMember,
      signal?: AbortSignal
    ) => Effect.Effect<AccountLimits, Error, RouteKitPlatform>,
    signal?: AbortSignal
  ) {
    const self = this;
    return Effect.gen(function* () {
      if (self.provider.consumeResetCredit === undefined) {
        return yield* Effect.fail(
          new RouteKitFailure({
            message: `${self.provider.mode} does not support redeemable rate-limit resets`
          })
        );
      }
      const expectedCooldownRevision = self.tracker.cooldownRevision(member.id);
      const redeemRequestId = input.redeemRequestId?.trim() || randomUUID();
      let creditId = input.creditId?.trim();
      if (creditId !== undefined && creditId.length === 0) {
        return yield* Effect.fail(new RouteKitFailure({ message: "creditId must not be empty" }));
      }
      if (creditId === undefined) {
        const listed = yield* self.list(member, signal);
        const available = (listed.credits ?? []).filter((credit) => {
          const status = credit.status?.toLowerCase();
          return status === undefined || status === "available" || status === "active";
        });
        if (available.length === 0 && listed.availableCount === 0) {
          return yield* Effect.fail(
            new RouteKitFailure({
              message: `${self.provider.mode}/${member.label} has no redeemable rate-limit resets`
            })
          );
        }
        const pick = [...available].sort(
          (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)
        )[0];
        creditId = pick?.id;
      }
      const consume = self.provider.consumeResetCredit;
      if (consume === undefined) {
        return yield* Effect.fail(
          new RouteKitFailure({
            message: `${self.provider.mode} does not support redeemable rate-limit resets`
          })
        );
      }
      const result = yield* consume(
        member.credential,
        {
          redeemRequestId,
          ...(creditId !== undefined ? { creditId } : {})
        },
        signal
      );
      if (result.ok) {
        yield* fetchUsage(member, signal).pipe(
          Effect.flatMap((usageLimits) => self.attach(member, usageLimits, signal)),
          Effect.flatMap((withResets) => self.tracker.update(member.id, withResets)),
          Effect.catch(() => Effect.void)
        );
        if (yield* self.tracker.clearCooling(member.id, expectedCooldownRevision)) {
          delete member.coolingUntil;
        } else {
          member.coolingUntil = self.tracker.coolingUntil(member.id);
        }
        member.cooldownRevision = self.tracker.cooldownRevision(member.id);
      }
      return {
        ...result,
        label: member.label,
        mode: self.provider.mode,
        ...(creditId !== undefined && result.creditId === undefined ? { creditId } : {})
      };
    });
  }
}
