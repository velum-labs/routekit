import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AccountActivityCoordinator,
  type AccountAuthCoordinator,
  cliproxyAccountEntries,
  cliproxyAccountMatchesKind,
  defaultSubscriptionAccountDirectory,
  RateLimitTracker,
  removeCliproxyAccount,
  removeSubscriptionAccount,
  renameSubscriptionAccount,
  sanitizeSubscriptionLabel,
  subscriptionAccountIdentity
} from "@velum-labs/routekit-accounts";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { resolveAccountConnector } from "@velum-labs/routekit-registry";
import { ControlError, writeFileAtomic } from "@velum-labs/routekit-runtime";
import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AccountApplicationServiceOptions } from "./account-application-options.js";
import {
  cleanupAccountTransaction,
  markAccountTransactionCommitted,
  type PreparedAccountTransaction,
  prepareAccountTransaction,
  rollbackAccountTransaction
} from "./account-transaction.js";
import { controlTry } from "./control-effect.js";
import { daemonAccountServices } from "./effect/services.js";
import { accountEntries, parseConfigDocument } from "./daemon-maintenance.js";

type AccountMutationHandlers = Pick<
  EffectRouteKitControlHandlers,
  | "accounts.remove"
  | "accounts.rename"
  | "accounts.sync"
  | "accounts.resetCredits"
  | "accounts.redeemReset"
>;

function rollbackAccountCoordinators(
  transaction: PreparedAccountTransaction,
  home: string,
  activity: AccountActivityCoordinator,
  authHealth: AccountAuthCoordinator,
  error: unknown,
  message: string
) {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        rollbackAccountTransaction(transaction, home);
      },
      catch: (rollbackError) => new AggregateError([error, rollbackError], message)
    });
    yield* activity
      .reload()
      .pipe(
        Effect.mapError((rollbackError) => new AggregateError([error, rollbackError], message))
      );
    yield* authHealth
      .reload()
      .pipe(
        Effect.mapError((rollbackError) => new AggregateError([error, rollbackError], message))
      );
    return yield* Effect.fail(routeKitError(error));
  });
}

/** Owns account removal, rename, sync, and credit redemption. */
export class AccountMutationService {
  constructor(private readonly options: AccountApplicationServiceOptions) {}

  handlers(): AccountMutationHandlers {
    const { onTransactionPhase } = this.options;
    return {
      "accounts.remove": (params) =>
        Effect.gen(function* () {
          const {
            env: daemonEnv,
            state: runtimeState,
            generations,
            activity,
            auth: authHealth,
            sidecar
          } = yield* daemonAccountServices;
          const env = daemonEnv.env;
          const home = daemonEnv.home;
          const configPath = daemonEnv.configPath;
          const replaceRouter = generations.replace;
          const resolved = yield* controlTry(() => {
            const connector = resolveAccountConnector(params.kind);
            if (connector === undefined) {
              throw new ControlError({
                code: "bad_request",
                message: `unknown subscription kind: ${params.kind}`
              });
            }
            return connector;
          });
          const kind = resolved.kind;
          let removed = false;
          yield* runtimeState.serializeEffect(
            Effect.gen(function* () {
              const directory =
                resolved.info.connector === "native"
                  ? defaultSubscriptionAccountDirectory(kind as SubscriptionMode, env)
                  : undefined;
              const nativePath =
                directory === undefined ? undefined : join(directory, `${params.label}.json`);
              if (nativePath !== undefined && existsSync(nativePath)) {
                const nativeKind = kind as SubscriptionMode;
                const hasRemainingAccount = accountEntries(env).some(
                  (entry) =>
                    entry.connector === "native" &&
                    entry.subscriptionKind === nativeKind &&
                    entry.label !== params.label
                );
                const raw = parseYaml(runtimeState.document) as Record<string, unknown>;
                const providers =
                  typeof raw.providers === "object" &&
                  raw.providers !== null &&
                  !Array.isArray(raw.providers)
                    ? { ...(raw.providers as Record<string, unknown>) }
                    : {};
                const disableProvider =
                  !hasRemainingAccount && runtimeState.config.providers[nativeKind] !== undefined;
                if (disableProvider) {
                  delete providers[nativeKind];
                  raw.providers = providers;
                  if (
                    typeof raw.defaultModel === "string" &&
                    raw.defaultModel.startsWith(`${nativeKind}/`)
                  ) {
                    delete raw.defaultModel;
                  }
                }
                const document = disableProvider ? stringifyYaml(raw) : runtimeState.document;
                const config = disableProvider
                  ? parseConfigDocument(document)
                  : runtimeState.config;
                const transaction = prepareAccountTransaction({
                  home,
                  configPath,
                  accountPaths: [
                    nativePath,
                    join(home, "usage", "account-activity.v1.json"),
                    join(home, "subscriptions", "account-auth.v1.json")
                  ],
                  accountRoots: [dirname(nativePath), home, join(home, "subscriptions")],
                  kind: nativeKind,
                  provider: nativeKind,
                  labels: [params.label]
                });
                const rollbackMessage = `could not remove ${kind}/${params.label}; rollback failed`;
                yield* Effect.gen(function* () {
                  const outcome = yield* controlTry(() => {
                    const result = removeSubscriptionAccount(nativeKind, params.label, {
                      accountsDirectory: dirname(nativePath)
                    });
                    if (!result.removed) cleanupAccountTransaction(transaction);
                    return result;
                  });
                  removed = outcome.removed;
                  if (!removed) return;
                  yield* replaceRouter(config, document, {
                    write: disableProvider,
                    configRevision: disableProvider,
                    accountRevision: true,
                    persist: () =>
                      Effect.gen(function* () {
                        yield* activity.remove(
                          subscriptionAccountIdentity(nativeKind, params.label)
                        );
                        yield* authHealth.remove(
                          subscriptionAccountIdentity(nativeKind, params.label)
                        );
                        markAccountTransactionCommitted(transaction);
                      })
                  });
                  yield* controlTry(() => cleanupAccountTransaction(transaction)).pipe(
                    Effect.ignore
                  );
                }).pipe(
                  Effect.catch((error) =>
                    rollbackAccountCoordinators(
                      transaction,
                      home,
                      activity,
                      authHealth,
                      error,
                      rollbackMessage
                    )
                  )
                );
                return;
              }
              const entry = cliproxyAccountEntries(env).find(
                (candidate) =>
                  candidate.label === params.label && cliproxyAccountMatchesKind(candidate, kind)
              );
              if (entry === undefined) return;
              const previous = yield* controlTry(() => readFileSync(entry.path));
              const cliproxyResult = yield* controlTry(() =>
                removeCliproxyAccount(params.label, env)
              );
              removed = cliproxyResult.removed;
              if (!removed) return;
              yield* Effect.gen(function* () {
                yield* sidecar.refresh();
                yield* replaceRouter(runtimeState.config, runtimeState.document, {
                  write: false,
                  accountRevision: true
                });
              }).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* controlTry(() => {
                      writeFileAtomic(entry.path, previous.toString("utf8"), { mode: 0o600 });
                      chmodSync(entry.path, 0o600);
                    });
                    yield* sidecar.refresh().pipe(Effect.ignore);
                    return yield* Effect.fail(routeKitError(error));
                  })
                )
              );
            })
          );
          return { removed, revision: runtimeState.revisions.accounts };
        }),
      "accounts.rename": (params) =>
        Effect.gen(function* () {
          const {
            env: daemonEnv,
            state: runtimeState,
            generations,
            activity,
            auth: authHealth
          } = yield* daemonAccountServices;
          const env = daemonEnv.env;
          const home = daemonEnv.home;
          const configPath = daemonEnv.configPath;
          const replaceRouter = generations.replace;
          const kind = yield* controlTry(() => {
            const resolved = resolveAccountConnector(params.kind);
            if (resolved === undefined || resolved.info.connector !== "native") {
              throw new ControlError({
                code: "bad_request",
                message: "account rename supports only claude-code and codex"
              });
            }
            for (const [field, label] of [
              ["source", params.source],
              ["target", params.target]
            ] as const) {
              if (sanitizeSubscriptionLabel(label) !== label || label.startsWith(".")) {
                throw new ControlError({
                  code: "bad_request",
                  message: `${field} account label must already be normalized`
                });
              }
            }
            return resolved.kind as SubscriptionMode;
          });
          yield* runtimeState.serializeEffect(
            Effect.gen(function* () {
              const directory = defaultSubscriptionAccountDirectory(kind, env);
              const sourcePath = join(directory, `${params.source}.json`);
              const targetPath = join(directory, `${params.target}.json`);
              yield* controlTry(() => {
                if (!existsSync(sourcePath)) {
                  throw new ControlError({
                    code: "not_found",
                    message: `${kind}/${params.source} is not enrolled`
                  });
                }
                try {
                  lstatSync(targetPath);
                  throw new ControlError({
                    code: "conflict",
                    message: `${kind}/${params.target} is already enrolled`
                  });
                } catch (error) {
                  if (
                    error instanceof ControlError ||
                    typeof error !== "object" ||
                    error === null ||
                    !("code" in error) ||
                    error.code !== "ENOENT"
                  ) {
                    throw error;
                  }
                }
              });
              const transaction = prepareAccountTransaction({
                home,
                configPath,
                accountPaths: [
                  sourcePath,
                  targetPath,
                  join(directory, ".state.json"),
                  join(home, "usage", "account-activity.v1.json"),
                  join(home, "subscriptions", "account-auth.v1.json")
                ],
                accountRoots: [directory, home, join(home, "subscriptions")],
                kind,
                provider: kind,
                labels: [params.source, params.target]
              });
              yield* Effect.gen(function* () {
                yield* controlTry(() => {
                  renameSubscriptionAccount(kind, params.source, params.target, {
                    accountsDirectory: directory
                  });
                });
                const tracker = yield* RateLimitTracker.open(join(directory, ".state.json"), kind);
                yield* tracker.renameMember(params.source, params.target);
                onTransactionPhase?.("credentials-written");
                yield* replaceRouter(runtimeState.config, runtimeState.document, {
                  write: false,
                  accountRevision: true,
                  persist: () =>
                    Effect.gen(function* () {
                      yield* activity.rename(
                        subscriptionAccountIdentity(kind, params.source),
                        subscriptionAccountIdentity(kind, params.target)
                      );
                      yield* authHealth.rename(
                        subscriptionAccountIdentity(kind, params.source),
                        subscriptionAccountIdentity(kind, params.target)
                      );
                      markAccountTransactionCommitted(transaction);
                    })
                });
                yield* controlTry(() => cleanupAccountTransaction(transaction)).pipe(Effect.ignore);
              }).pipe(
                Effect.catch((error) =>
                  rollbackAccountCoordinators(
                    transaction,
                    home,
                    activity,
                    authHealth,
                    error,
                    `could not rename ${kind}/${params.source}; rollback failed`
                  )
                )
              );
            })
          );
          return { renamed: true, revision: runtimeState.revisions.accounts };
        }),
      "accounts.sync": () =>
        Effect.gen(function* () {
          const { state: runtimeState, generations, sidecar } = yield* daemonAccountServices;
          return yield* runtimeState.serializeEffect(
            Effect.gen(function* () {
              yield* sidecar.refresh();
              yield* generations.replace(runtimeState.config, runtimeState.document, {
                write: false,
                accountRevision: true
              });
              return { synced: true as const, revision: runtimeState.revisions.accounts };
            })
          );
        }),
      "accounts.resetCredits": (params, context) =>
        Effect.gen(function* () {
          const { gateway } = yield* daemonAccountServices;
          return yield* gateway
            .router()!
            .listResetCredits(params.kind, params.label, context.signal)
            .pipe(
              Effect.map((resetCredits) => ({
                kind: params.kind,
                label: params.label,
                resetCredits
              })),
              Effect.catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                if (
                  message.includes("is not enrolled") ||
                  message.includes("no codex account pool")
                ) {
                  return Effect.fail(new ControlError({ code: "not_found", message }));
                }
                return Effect.fail(routeKitError(error));
              })
            );
        }),
      "accounts.redeemReset": (params, context) =>
        Effect.gen(function* () {
          const { gateway } = yield* daemonAccountServices;
          return yield* gateway
            .router()!
            .redeemReset(
              {
                kind: params.kind,
                label: params.label,
                ...(params.creditId !== undefined ? { creditId: params.creditId } : {}),
                ...(params.redeemRequestId !== undefined
                  ? { redeemRequestId: params.redeemRequestId }
                  : {})
              },
              context.signal
            )
            .pipe(
              Effect.map((result) => ({
                ok: result.ok,
                code: result.code,
                kind: "codex" as const,
                label: result.label,
                redeemRequestId: result.redeemRequestId,
                ...(result.creditId !== undefined ? { creditId: result.creditId } : {}),
                ...(result.windowsReset !== undefined ? { windowsReset: result.windowsReset } : {}),
                usage: result.usage
              })),
              Effect.catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes("is not enrolled") || message.includes("no redeemable")) {
                  return Effect.fail(new ControlError({ code: "not_found", message }));
                }
                if (
                  message.includes("does not support") ||
                  message.includes("no codex account pool") ||
                  message.includes("creditId must not be empty") ||
                  message.includes("account label is required")
                ) {
                  return Effect.fail(new ControlError({ code: "bad_request", message }));
                }
                return Effect.fail(new ControlError({ code: "internal", message }));
              })
            );
        })
    };
  }
}
