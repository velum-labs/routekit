import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import type { AccountActivityCoordinator } from "../activity.js";
import { subscriptionAccountIdentity } from "../activity.js";
import { poolReadiness } from "../admission.js";
import type { AccountAuthCoordinator } from "../auth-health.js";
import type { RateLimitTracker } from "../rate-limit-tracker.js";
import type {
  SubscriptionPoolMember,
  SubscriptionPoolSelector
} from "../subscription-pool-selection.js";
import type {
  AccountLimits,
  SubscriptionAccountSetSnapshot,
  SubscriptionSelectionStrategy
} from "../types.js";

export class AccountSetStatusService<M extends SubscriptionMode> {
  constructor(
    private readonly mode: M,
    private readonly strategy: SubscriptionSelectionStrategy,
    private readonly switchThreshold: number,
    private readonly members: SubscriptionPoolMember[],
    private readonly tracker: RateLimitTracker,
    private readonly activity: AccountActivityCoordinator,
    private readonly authHealth: AccountAuthCoordinator,
    private readonly selector: SubscriptionPoolSelector,
    private readonly catalogReady: () => boolean
  ) {}

  snapshot(): SubscriptionAccountSetSnapshot {
    return {
      mode: this.mode,
      strategy: this.strategy,
      switchThreshold: this.switchThreshold,
      members: this.members.map((member) => this.memberStatus(member))
    };
  }

  statusSnapshot(): SubscriptionAccountSetSnapshot {
    const snapshot = this.snapshot();
    const now = Date.now() / 1000;
    return {
      ...snapshot,
      members: snapshot.members.map((status) => {
        const member = this.members.find((candidate) => candidate.id === status.id)!;
        const credentialValid =
          member.credential.accessToken.length > 0 &&
          (member.credential.expiresAt === undefined ||
            member.credential.expiresAt > now ||
            (member.credential.refreshToken?.length ?? 0) > 0);
        const readiness = poolReadiness({
          limits: this.tracker.limits(member.id),
          switchThreshold: this.switchThreshold,
          ...(member.coolingUntil !== undefined ? { coolingUntil: member.coolingUntil } : {}),
          ...(member.credential.expiresAt !== undefined
            ? { credentialExpiresAt: member.credential.expiresAt }
            : {}),
          hasRefreshToken: member.credential.refreshToken !== undefined,
          catalogReady: this.catalogReady(),
          models: [...member.models],
          now,
          isWindowRelevant: (key, limitName) =>
            this.selector.windowRelevant(key, limitName, undefined)
        });
        const auth = this.authHealth.snapshot(
          subscriptionAccountIdentity(this.mode, member.label),
          member.credentialFingerprint
        );
        const upstreamAuthState = auth.kind === "superseded" ? "unknown" : auth.kind;
        const readinessReasons = credentialValid
          ? [
              ...(auth.kind === "refreshing"
                ? [{ code: "provider_auth_refreshing" as const }]
                : auth.kind === "backoff" && auth.retryAt !== undefined
                  ? [{ code: "provider_auth_backoff" as const, until: auth.retryAt / 1000 }]
                  : auth.kind === "rejected"
                    ? [{ code: "provider_auth_rejected" as const, status: auth.status ?? 401 }]
                    : []),
              ...readiness.reasons
            ]
          : member.credential.expiresAt !== undefined && member.credential.expiresAt <= now
            ? readiness.reasons
            : [{ code: "credential_invalid" as const }, ...readiness.reasons];
        const poolEligible =
          readiness.eligible &&
          (auth.kind === "unknown" ||
            auth.kind === "accepted" ||
            (auth.kind === "backoff" && (auth.retryAt ?? Infinity) <= Date.now()));
        return {
          ...status,
          credentialValid,
          upstreamAuthState,
          poolEligible,
          relayReady: credentialValid && poolEligible,
          readinessReasons
        };
      })
    };
  }

  private memberStatus(member: SubscriptionPoolMember) {
    const activity = this.activity.snapshot(subscriptionAccountIdentity(this.mode, member.label));
    const limits = this.tracker.limits(member.id);
    return {
      id: member.id,
      mode: this.mode,
      label: member.label,
      sourcePath: member.sourcePath,
      ...(member.credential.expiresAt !== undefined
        ? { expiresAt: member.credential.expiresAt }
        : {}),
      ...(member.coolingUntil !== undefined ? { coolingUntil: member.coolingUntil } : {}),
      ...activity,
      models: [...member.models],
      ...(limits !== undefined ? { limits } : {})
    };
  }
}
