import { existsSync } from "node:fs";
import type { RouterConfig } from "@velum-labs/routekit-config";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import type { RunningControlServer } from "@velum-labs/routekit-runtime";
import type { AccountTransactionRecovery } from "./account-transaction.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import { accountEntries } from "./daemon-maintenance.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";

type DoctorHandlers = Pick<RouteKitControlHandlers, "doctor.run">;

export type DoctorApplicationServiceOptions = {
  env: NodeJS.ProcessEnv;
  configPath: string;
  dataUrl: string;
  runtimeState: DaemonRuntimeState;
  sidecar: CliproxySidecar;
  accountRecovery: AccountTransactionRecovery;
  activeRouter: () => RunningRouter | undefined;
  proxy: () => SwitchingGatewayProxy | undefined;
  control: () => RunningControlServer | undefined;
  wantsCliproxySidecar: (config: RouterConfig) => boolean;
};

/** Owns daemon diagnostic checks for local configuration and live providers. */
export class DoctorApplicationService {
  constructor(private readonly options: DoctorApplicationServiceOptions) {}

  handlers(): DoctorHandlers {
    const options = this.options;
    return {
      "doctor.run": async (_params, context) => {
        const providers = await options.activeRouter()!.providerStatuses(context.signal);
        const configuredProviders = configuredProviderIds(options.runtimeState.config);
        const accounts = accountEntries(options.env);
        const missingProviders = [
          ...new Set(
            accounts
              .filter((entry) => {
                const provider =
                  entry.connector === "cliproxy" ? "cliproxy" : entry.subscriptionKind;
                return options.runtimeState.config.providers[provider] === undefined;
              })
              .map((entry) => entry.subscriptionKind)
          )
        ];
        const providerOnly = ["claude-code", "codex", "cliproxy"].filter(
          (provider) =>
            (options.runtimeState.config.providers as Record<string, unknown>)[provider] !==
              undefined &&
            !accounts.some((entry) =>
              provider === "cliproxy"
                ? entry.connector === "cliproxy"
                : entry.subscriptionKind === provider
            )
        );
        const consistent = missingProviders.length === 0 && providerOnly.length === 0;
        return {
          checks: [
            {
              name: "canonical config",
              ok: existsSync(options.configPath),
              detail: options.configPath
            },
            { name: "control plane", ok: options.control !== undefined },
            { name: "model gateway", ok: options.proxy !== undefined, detail: options.dataUrl },
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
            ...(options.wantsCliproxySidecar(options.runtimeState.config)
              ? [
                  {
                    name: "cliproxy sidecar",
                    ok: await options.sidecar.reachable(),
                    detail: options.sidecar.managed()
                      ? options.sidecar.running()
                        ? "managed; running"
                        : "managed; not running"
                      : "external"
                  }
                ]
              : []),
            ...providers.map((provider) => ({
              name: `${provider.provider} live discovery`,
              ok: provider.ok,
              detail: provider.error ?? `${provider.models.length} model(s)`
            }))
          ]
        };
      }
    };
  }
}
