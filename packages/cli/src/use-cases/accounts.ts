import { createHash } from "node:crypto";
import { captureLoginCredential } from "@velum-labs/routekit-accounts";
import type { RouteKitControlClient } from "@velum-labs/routekit-control";
import { runCliEffect } from "../cli-session.js";
import { LAUNCH_ACCOUNT_KINDS } from "../launch-support.js";

export function activationKey(
  kind: string,
  accounts: Array<{ label: string; credential?: unknown }>
): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        kind,
        labels: accounts.map((account) => account.label)
      })
    )
    .digest("hex");
  return `account-enroll-activate-${fingerprint}`;
}

export type LoginAndActivateSubscriptionInput = {
  client: RouteKitControlClient;
  kind: (typeof LAUNCH_ACCOUNT_KINDS)[number];
  label: string;
  noBrowser?: boolean;
};

export type LoginAndActivateSubscriptionResult = {
  kind: (typeof LAUNCH_ACCOUNT_KINDS)[number];
  label: string;
  provider: string;
  configPath: string;
  accountRevision: number;
  configRevision: number;
  modelCount: number;
};

export class LoginAndActivateSubscription {
  async execute(
    input: LoginAndActivateSubscriptionInput
  ): Promise<LoginAndActivateSubscriptionResult> {
    const existing = (await runCliEffect(input.client.call("accounts.status", {}))).accounts.find(
      (entry) => entry.subscriptionKind === input.kind && entry.label === input.label
    );
    const accounts =
      existing !== undefined
        ? [{ label: input.label }]
        : [
            await captureLoginCredential(input.kind, input.label, {
              ...(input.noBrowser === true ? { noBrowser: true } : {})
            }).then((result) => ({
              label: result.label,
              credential: result.credential
            }))
          ];
    const activated = await runCliEffect(
      input.client.call(
        "accounts.enrollActivate",
        { kind: input.kind, accounts },
        { idempotencyKey: activationKey(input.kind, accounts) }
      )
    );
    const models = await runCliEffect(input.client.call("models.list", { provider: input.kind }));
    return {
      kind: input.kind,
      label: input.label,
      provider: input.kind,
      configPath: activated.configPath,
      accountRevision: activated.accountRevision,
      configRevision: activated.configRevision,
      modelCount: models.models.length
    };
  }
}
