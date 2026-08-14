import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { Effect } from "effect";
import type { AccountApplicationServiceOptions } from "./account-application-options.js";
import { daemonAccountServices } from "./effect/services.js";
import { accountEntries } from "./daemon-maintenance.js";

type AccountQueryHandlers = Pick<
  EffectRouteKitControlHandlers,
  "accounts.list" | "accounts.status" | "accounts.usage"
>;

/** Owns account inventory, live status, and usage queries. */
export class AccountQueryService {
  constructor(private readonly options: AccountApplicationServiceOptions) {}

  handlers(): AccountQueryHandlers {
    const { recovery } = this.options;
    return {
      "accounts.list": () =>
        Effect.gen(function* () {
          const { env: daemonEnv, state: runtimeState } = yield* daemonAccountServices;
          return {
            accounts: accountEntries(daemonEnv.env).map((entry) => {
              if (entry.connector === "native") return entry;
              const { credentialValid: _credentialValid, ...listed } = entry;
              return listed;
            }),
            revision: runtimeState.revisions.accounts
          };
        }),
      "accounts.status": () =>
        Effect.gen(function* () {
          const {
            env: daemonEnv,
            state: runtimeState,
            sidecar,
            gateway
          } = yield* daemonAccountServices;
          const env = daemonEnv.env;
          const entries = accountEntries(env);
          const cliproxyConfigured = runtimeState.config.providers.cliproxy !== undefined;
          const cliproxyReachable =
            entries.some((entry) => entry.connector === "cliproxy") && cliproxyConfigured
              ? yield* sidecar.reachable()
              : false;
          return {
            accounts: entries.map((entry) => {
              if (entry.connector === "cliproxy") {
                const ready = entry.credentialValid && cliproxyConfigured && cliproxyReachable;
                return {
                  subscriptionKind: entry.subscriptionKind,
                  label: entry.label,
                  connector: entry.connector,
                  ...(entry.localOnly === true ? { localOnly: true } : {}),
                  credentialValid: entry.credentialValid,
                  configured: cliproxyConfigured,
                  relayOpen: ready,
                  serving: false,
                  inFlight: 0,
                  lastSelected: false,
                  ...(entry.credentialValid
                    ? {}
                    : { readinessReasons: [{ code: "credential_invalid" as const }] }),
                  models: []
                };
              }
              const member = gateway
                .router()!
                .accountSnapshots()
                .find((snapshot) => snapshot.mode === entry.subscriptionKind)
                ?.members.find((candidate) => candidate.label === entry.label);
              return {
                subscriptionKind: entry.subscriptionKind,
                label: entry.label,
                connector: entry.connector,
                credentialValid: member?.credentialValid ?? false,
                ...(member?.upstreamAuthState !== undefined
                  ? { upstreamAuthState: member.upstreamAuthState }
                  : {}),
                configured: runtimeState.config.providers[entry.subscriptionKind] !== undefined,
                relayOpen:
                  member?.relayReady === true &&
                  runtimeState.config.providers[entry.subscriptionKind] !== undefined,
                serving: member?.serving ?? false,
                inFlight: member?.inFlight ?? 0,
                ...(member?.lastSelectedAt !== undefined
                  ? { lastSelectedAt: member.lastSelectedAt }
                  : {}),
                lastSelected: member?.lastSelected ?? false,
                ...(member?.readinessReasons !== undefined
                  ? { readinessReasons: member.readinessReasons }
                  : member === undefined
                    ? { readinessReasons: [{ code: "credential_invalid" as const }] }
                    : {}),
                models: member?.models ?? [],
                ...(member?.limits !== undefined ? { limits: member.limits } : {})
              };
            }),
            revision: runtimeState.revisions.accounts,
            recovery: {
              state: recovery.recovered > 0 ? ("recovered" as const) : ("clean" as const),
              recovered: recovery.recovered,
              cleaned: recovery.cleaned
            }
          };
        }),
      "accounts.usage": (_params, context) =>
        Effect.gen(function* () {
          const { gateway } = yield* daemonAccountServices;
          return yield* gateway.router()!.usage(context.signal);
        })
    };
  }
}
