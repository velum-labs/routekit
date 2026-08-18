import { existsSync } from "node:fs";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { Effect } from "effect";
import { accountEntries } from "../../daemon-maintenance.js";
import { AccountRecovery } from "../account-recovery/service.js";
import { ActiveGateway } from "../active-gateway/service.js";
import { DaemonEnv } from "../daemon-env/service.js";
import { DaemonPolicy } from "../daemon-policy/service.js";
import { DaemonState } from "../daemon-state/service.js";
import { Sidecar } from "../sidecar/service.js";

type DoctorHandlers = Pick<EffectRouteKitControlHandlers, "doctor.run">;

/** Owns daemon diagnostic checks for local configuration and live providers. */
export class DoctorApplicationService {
  handlers(): DoctorHandlers {
    return {
      "doctor.run": (_params, context) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const sidecar = yield* Sidecar;
          const gateway = yield* ActiveGateway;
          const recovery = yield* AccountRecovery;
          const policy = yield* DaemonPolicy;
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
          const cliproxyCheck = policy.wantsCliproxySidecar(state.config)
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
                  recovery.recovered > 0
                    ? `recovered ${recovery.recovered} interrupted operation(s)`
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
