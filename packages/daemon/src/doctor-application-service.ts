import { existsSync } from "node:fs";
import type { RouterConfig } from "@velum-labs/routekit-config";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { Effect } from "effect";
import type { AccountTransactionRecovery } from "./account-transaction.js";
import { accountEntries } from "./daemon-maintenance.js";
import { ActiveGateway, DaemonEnv, DaemonState, Sidecar } from "./effect/services.js";

type DoctorHandlers = Pick<EffectRouteKitControlHandlers, "doctor.run">;

export type DoctorApplicationServiceOptions = {
  accountRecovery: AccountTransactionRecovery;
  wantsCliproxySidecar: (config: RouterConfig) => boolean;
};

/** Owns daemon diagnostic checks for local configuration and live providers. */
export class DoctorApplicationService {
  constructor(private readonly options: DoctorApplicationServiceOptions) {}

  handlers(): DoctorHandlers {
    const options = this.options;
    return {
      "doctor.run": (_params, context) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const sidecar = yield* Sidecar;
          const gateway = yield* ActiveGateway;
          const providers = yield* gateway.router()!.providerStatuses(context.signal);
          const configuredProviders = configuredProviderIds(state.config);
          const accounts = accountEntries(env.env);
          const missingProviders = [
            ...new Set(
              accounts
                .filter((entry) => {
                  const provider =
                    entry.connector === "cliproxy" ? "cliproxy" : entry.subscriptionKind;
                  return state.config.providers[provider] === undefined;
                })
                .map((entry) => entry.subscriptionKind)
            )
          ];
          const providerOnly = ["claude-code", "codex", "cliproxy"].filter(
            (provider) =>
              (state.config.providers as Record<string, unknown>)[provider] !== undefined &&
              !accounts.some((entry) =>
                provider === "cliproxy"
                  ? entry.connector === "cliproxy"
                  : entry.subscriptionKind === provider
              )
          );
          const consistent = missingProviders.length === 0 && providerOnly.length === 0;
          const cliproxyCheck = options.wantsCliproxySidecar(state.config)
            ? [
                {
                  name: "cliproxy sidecar",
                  ok: yield* sidecar.reachable(),
                  detail: sidecar.managed()
                    ? sidecar.running()
                      ? "managed; running"
                      : "managed; not running"
                    : "external"
                }
              ]
            : [];
          return {
            checks: [
              {
                name: "canonical config",
                ok: existsSync(env.configPath),
                detail: env.configPath
              },
              { name: "control plane", ok: gateway.control() !== undefined },
              {
                name: "model gateway",
                ok: gateway.proxy() !== undefined,
                detail: gateway.dataUrl()
              },
              {
                name: "provider configuration",
                ok: configuredProviders.length > 0,
                detail:
                  configuredProviders.length > 0
                    ? `${configuredProviders.length} provider(s) configured`
                    : "no providers configured; run `routekit providers add <provider>`"
              },
              {
                name: "account activation recovery",
                ok: true,
                detail:
                  options.accountRecovery.recovered > 0
                    ? `recovered ${options.accountRecovery.recovered} interrupted operation(s)`
                    : "clean"
              },
              {
                name: "account/provider consistency",
                ok: consistent,
                detail: consistent
                  ? "consistent"
                  : [
                      ...(missingProviders.length > 0
                        ? [`routing disabled: ${missingProviders.join(", ")}`]
                        : []),
                      ...(providerOnly.length > 0
                        ? [`credential missing: ${providerOnly.join(", ")}`]
                        : [])
                    ].join("; ")
              },
              ...cliproxyCheck,
              ...providers.map((provider) => ({
                name: `${provider.provider} live discovery`,
                ok: provider.ok,
                detail: provider.error ?? `${provider.models.length} model(s)`
              }))
            ]
          };
        })
    };
  }
}
