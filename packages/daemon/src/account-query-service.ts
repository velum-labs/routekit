import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { AccountApplicationServiceOptions } from "./account-application-options.js";
import { accountEntries } from "./daemon-maintenance.js";

type AccountQueryHandlers = Pick<
  RouteKitControlHandlers,
  "accounts.list" | "accounts.status" | "accounts.usage"
>;

/** Owns account inventory, live status, and usage queries. */
export class AccountQueryService {
  constructor(private readonly options: AccountApplicationServiceOptions) {}

  handlers(): AccountQueryHandlers {
    const { env, runtimeState, sidecar, recovery, activeRouter } = this.options;
    return {
      "accounts.list": async () => ({
        accounts: accountEntries(env).map((entry) => {
          if (entry.connector === "native") return entry;
          const { credentialValid: _credentialValid, ...listed } = entry;
          return listed;
        }),
        revision: runtimeState.revisions.accounts
      }),
      "accounts.status": async () => {
        const entries = accountEntries(env);
        const cliproxyConfigured = runtimeState.config.providers.cliproxy !== undefined;
        const cliproxyReachable =
          entries.some((entry) => entry.connector === "cliproxy") && cliproxyConfigured
            ? await sidecar.reachable()
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
            const member = activeRouter()
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
      },
      "accounts.usage": async (_params, context) => await activeRouter().usage(context.signal)
    };
  }
}
