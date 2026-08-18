import { readFileSync } from "node:fs";

import {
  captureCliproxyLoginCredentials,
  defaultSubscriptionCredentialPath,
  parseAccountMode,
  resolveAccountKind
} from "@velum-labs/routekit-accounts";
import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { resolveAccountConnector } from "@velum-labs/routekit-registry";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { randomId } from "@velum-labs/routekit-runtime/timing";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  formatAccountActivityMarkers,
  formatAccountsStatusDetail
} from "../../account-status-format.js";
import { withCliClient } from "../../cli-client.js";
import { cliTry, cliTryPromise } from "../../cli-session.js";
import { isLaunchAccountKind, LAUNCH_ACCOUNT_KINDS } from "../../launch-support.js";
import { activationKey, LoginAndActivateSubscription } from "../../services/account-login/service.js";
import { routekitRoot } from "../root-command.js";

const LOCAL_ONLY_WARNING =
  "this connector reuses subscription OAuth tokens through reverse-engineered " +
  "endpoints; providers restrict that to personal/local use — do not expose it " +
  "through a shared gateway";

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

function providerForKind(kind: string, connector: "native" | "cliproxy"): string {
  return connector === "cliproxy" ? "cliproxy" : kind;
}

function isCliproxyAccount(entry: { subscriptionKind?: string; connector?: string }): boolean {
  if (entry.connector === "cliproxy") return true;
  if (entry.subscriptionKind === undefined) return false;
  return resolveAccountConnector(entry.subscriptionKind)?.info.connector === "cliproxy";
}

export const makeAccountsCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const loginAndActivateSubscription = new LoginAndActivateSubscription();
  const login = Command.make(
    "login",
    {
      subscriptionKind: Argument.string("subscription-kind"),
      name: optionalString("name").pipe(
        Flag.withDescription("account label (native subscription kinds)")
      ),
      noBrowser: Flag.boolean("no-browser").pipe(
        Flag.withDescription("prefer a browserless login flow (device code / copyable URL)")
      )
    },
    ({ name, noBrowser, subscriptionKind }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        if (ctx.json || ctx.noInput) {
          return yield* Effect.fail(
            new Error("`accounts login` is interactive and does not support --json or --no-input")
          );
        }
        if (resolveAccountConnector(subscriptionKind) === undefined) {
          return yield* Effect.fail(
            new Error(
              `unknown subscription kind ${JSON.stringify(subscriptionKind)}; first-launch kinds: ${LAUNCH_ACCOUNT_KINDS.join(", ")}`
            )
          );
        }
        const resolved = resolveAccountKind(subscriptionKind);
        const kind = resolved.kind;
        if (!isLaunchAccountKind(kind)) {
          return yield* Effect.fail(
            new Error(
              `subscription kind ${JSON.stringify(subscriptionKind)} is not offered at first launch; supported kinds: ${LAUNCH_ACCOUNT_KINDS.join(", ")}`
            )
          );
        }
        if (resolved.localOnly) ctx.presenter.warn(`${resolved.kind}: ${LOCAL_ONLY_WARNING}`);
        if (noBrowser && resolved.kind === "claude-code") {
          ctx.presenter.note(
            "claude-code has no native device-code login; RouteKit suppresses the local browser so Claude prints a copyable URL — open it on any device and paste the code back if prompted"
          );
        }
        if (resolved.connector === "native") {
          if (name === undefined) {
            return yield* Effect.fail(
              new Error(`\`accounts login ${resolved.kind}\` requires --name <label>`)
            );
          }
          const result = yield* withCliClient((client) =>
            loginAndActivateSubscription.execute({
              client,
              kind,
              label: name,
              ...(noBrowser ? { noBrowser } : {})
            })
          );
          ctx.presenter.success(`logged in, enrolled, and enabled ${result.kind}/${result.label}`);
          ctx.presenter.note(`config: ${result.configPath}`);
          if (result.modelCount === 0) {
            ctx.presenter.warn(
              `no live ${result.provider} models discovered yet; check \`routekit accounts status\``
            );
          } else {
            ctx.presenter.note(`${result.modelCount} live ${result.provider} model(s) available`);
          }
          return;
        }
        if (name !== undefined) {
          ctx.presenter.note(
            "--name is ignored for this kind; the account identity comes from the OAuth login"
          );
        }
        const captured = yield* cliTryPromise(() =>
          captureCliproxyLoginCredentials(resolved.kind, {
            ...(noBrowser ? { noBrowser } : {}),
            onProgress: (line) => ctx.presenter.note(line)
          })
        );
        const enrolledAccounts = captured.accounts.map((entry) => ({
          label: entry.label,
          credential: entry.credential
        }));
        const provider = providerForKind(resolved.kind, resolved.connector);
        const { activated, models } = yield* withCliClient((client) =>
          Effect.gen(function* () {
            const activated = yield* client.call(
              "accounts.enrollActivate",
              { kind: resolved.kind, accounts: enrolledAccounts },
              { idempotencyKey: activationKey(resolved.kind, enrolledAccounts) }
            );
            const models = yield* client.call("models.list", { provider });
            return { activated, models };
          })
        );
        for (const { label } of enrolledAccounts) {
          ctx.presenter.success(`logged in, enrolled, and enabled ${resolved.kind}/${label}`);
        }
        ctx.presenter.note(`config: ${activated.configPath}`);
        if (models.models.length === 0) {
          ctx.presenter.warn(
            `no live ${provider} models discovered yet; check \`routekit accounts status\``
          );
        } else {
          ctx.presenter.note(`${models.models.length} live ${provider} model(s) available`);
        }
      })
  ).pipe(
    Command.withDescription(`enroll a subscription account (${LAUNCH_ACCOUNT_KINDS.join(", ")})`)
  );

  const add = Command.make(
    "add",
    {
      subscriptionKind: Argument.string("subscription-kind"),
      name: optionalString("name").pipe(Flag.withDescription("account label"))
    },
    ({ name, subscriptionKind }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const kind = parseAccountMode(subscriptionKind);
        const label = name ?? `${kind}-default`;
        const enrolled = yield* withCliClient((client) =>
          Effect.gen(function* () {
            const existing = (yield* client.call("accounts.status", {})).accounts.find(
              (entry) => entry.subscriptionKind === kind && entry.label === label
            );
            const accounts =
              existing !== undefined
                ? [{ label }]
                : [
                    {
                      label,
                      credential: yield* cliTry(() =>
                        JSON.parse(
                          readFileSync(defaultSubscriptionCredentialPath(kind), "utf8")
                        ) as unknown
                      )
                    }
                  ];
            return yield* client.call(
              "accounts.enrollActivate",
              { kind, accounts },
              { idempotencyKey: activationKey(kind, accounts) }
            );
          })
        );
        const output = {
          subscriptionKind: kind,
          label,
          revision: enrolled.accountRevision,
          activated: true,
          configPath: enrolled.configPath
        };
        if (ctx.json) ctx.emit(output);
        else {
          ctx.presenter.success(`enrolled and enabled ${kind}/${label}`);
          ctx.presenter.note(`config: ${enrolled.configPath}`);
        }
      })
  ).pipe(Command.withDescription("enroll the current official CLI login (claude-code, codex)"));

  const rename = Command.make(
    "rename",
    {
      subscriptionKind: Argument.string("subscription-kind"),
      source: Argument.string("source"),
      target: Argument.string("target")
    },
    ({ source, subscriptionKind, target }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const kind = parseAccountMode(subscriptionKind);
        const result = yield* withCliClient((client) =>
          client.call(
            "accounts.rename",
            { kind, source, target },
            { idempotencyKey: `account-rename-${randomId(16)}` }
          )
        );
        if (ctx.json) ctx.emit({ ...result, subscriptionKind: kind, source, target });
        else ctx.presenter.success(`renamed ${kind}/${source} to ${kind}/${target}`);
      })
  ).pipe(Command.withDescription("rename an enrolled claude-code or codex account label"));

  const remove = Command.make(
    "remove",
    {
      subscriptionKind: Argument.string("subscription-kind"),
      name: Argument.string("name")
    },
    ({ name, subscriptionKind: provider }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const registryKind = resolveAccountConnector(provider);
        const kind = registryKind?.kind ?? provider;
        const { result, remaining, connector } = yield* withCliClient((client) =>
          Effect.gen(function* () {
            let connector = registryKind?.info.connector;
            if (connector === undefined) {
              const listed = yield* client.call("accounts.list", {});
              const rawEntry = (
                listed.accounts as Array<{
                  subscriptionKind?: string;
                  label?: string;
                  connector?: string;
                }>
              ).find(
                (entry) =>
                  entry.subscriptionKind === provider &&
                  entry.label === name &&
                  entry.connector === "cliproxy"
              );
              if (rawEntry === undefined) {
                return yield* new RouteKitFailure({
                  message: `unknown subscription kind ${JSON.stringify(provider)}`
                });
              }
              connector = "cliproxy";
            }
            const result = yield* client.call(
              "accounts.remove",
              { kind, label: name },
              { idempotencyKey: `account-remove-${randomId(16)}` }
            );
            const remaining = result.removed ? yield* client.call("accounts.list", {}) : undefined;
            return { result, remaining, connector };
          })
        );
        if (ctx.json) {
          ctx.emit({ ...result, subscriptionKind: kind, label: name });
        } else if (result.removed) {
          ctx.presenter.success(`removed ${kind}/${name}`);
          const accounts = remaining!.accounts as Array<{
            subscriptionKind?: string;
            connector?: string;
          }>;
          const routerProvider = providerForKind(kind, connector);
          const shouldSuggestProviderRemove =
            connector === "cliproxy"
              ? !accounts.some((entry) => isCliproxyAccount(entry))
              : accounts.every((entry) => entry.subscriptionKind !== kind);
          if (shouldSuggestProviderRemove && isLaunchAccountKind(kind)) {
            ctx.presenter.note(
              `run \`routekit providers remove ${routerProvider}\` to stop subscription routing`
            );
          }
        } else {
          ctx.presenter.note(`${kind}/${name} is not enrolled`);
        }
      })
  ).pipe(Command.withDescription("remove an enrolled account from RouteKit-managed state"));

  const list = Command.make("list", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const response = yield* withCliClient((client) => client.call("accounts.list", {}));
      const entries = response.accounts as Array<{
        subscriptionKind: string;
        label: string;
      }>;
      if (ctx.json) ctx.emit({ accounts: entries });
      else ctx.presenter.table(entries.map((entry) => [entry.subscriptionKind, entry.label]));
    })
  ).pipe(Command.withDescription("list enrolled accounts without reading credential values"));

  const status = Command.make("status", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const status = yield* withCliClient((client) => client.call("accounts.status", {}));
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      ctx.presenter.status("ok", "daemon account pool", `revision ${status.revision}`);
      if (status.recovery.recovered > 0) {
        ctx.presenter.note(`restored ${status.recovery.recovered} interrupted account activation(s)`);
      }
      for (const entry of status.accounts) {
        const ok =
          entry.credentialValid === true && entry.configured === true && entry.relayOpen === true;
        ctx.presenter.status(
          ok ? "ok" : "pending",
          `${entry.subscriptionKind}/${entry.label}${formatAccountActivityMarkers(entry)}`,
          formatAccountsStatusDetail(entry)
        );
      }
    })
  ).pipe(Command.withDescription("show pooled account and connector status"));

  return Command.make("accounts").pipe(
    Command.withDescription("manage pooled provider subscriptions"),
    Command.withSubcommands([login, add, rename, remove, list, status])
  );
};
