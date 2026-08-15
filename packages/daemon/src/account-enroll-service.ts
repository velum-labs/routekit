import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cliproxyAuthDirectory,
  defaultSubscriptionAccountDirectory,
  sanitizeSubscriptionLabel,
  subscriptionAccountIdentity,
  subscriptionCredentialFingerprint
} from "@velum-labs/routekit-accounts";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { resolveAccountConnector } from "@velum-labs/routekit-registry";
import { ControlError, writeFileAtomic } from "@velum-labs/routekit-runtime";
import { routeKitError, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  cleanupAccountTransaction,
  markAccountTransactionCommitted,
  prepareAccountTransaction,
  rollbackAccountTransaction
} from "./account-transaction.js";
import { controlTry } from "./control-effect.js";
import { DaemonHost, daemonAccountServices } from "./effect/services.js";
import {
  parseConfigDocument,
  safeCliproxyCredentialBlob,
  safeCliproxyLabel,
  safeCredentialBlob
} from "./daemon-maintenance.js";

type AccountEnrollHandlers = Pick<
  EffectRouteKitControlHandlers,
  "accounts.enroll" | "accounts.enrollActivate"
>;

/** Owns account enrollment and activation transactions. */
export class AccountEnrollService {
  handlers(): AccountEnrollHandlers {
    return {
      "accounts.enroll": (params) =>
        Effect.gen(function* () {
          const { env: daemonEnv, state: runtimeState, generations } = yield* daemonAccountServices;
          const host = yield* DaemonHost;
          const env = daemonEnv.env;
          return yield* runtimeState.serializeEffect(
            Effect.gen(function* () {
              const path = yield* controlTry(() => {
                const label = sanitizeSubscriptionLabel(params.label);
                if (label !== params.label || label.startsWith(".")) {
                  throw new ControlError({
                    code: "bad_request",
                    message: "account label must already be normalized"
                  });
                }
                const directory = defaultSubscriptionAccountDirectory(params.kind, env);
                mkdirSync(directory, { recursive: true, mode: 0o700 });
                const credentialPath = join(directory, `${label}.json`);
                if (existsSync(credentialPath)) {
                  throw new ControlError({
                    code: "conflict",
                    message: `${params.kind}/${label} is already enrolled; remove it before enrolling again`
                  });
                }
                writeFileAtomic(
                  credentialPath,
                  `${JSON.stringify(safeCredentialBlob(params.kind, params.credential), null, 2)}\n`,
                  { mode: 0o600 }
                );
                chmodSync(credentialPath, 0o600);
                return credentialPath;
              });
              yield* generations
                .replace(runtimeState.config, runtimeState.document, {
                  write: false,
                  accountRevision: true
                })
                .pipe(
                  Effect.catch((error) => {
                    rmSync(path, { force: true });
                    return Effect.fail(routeKitError(error));
                  })
                );
              return { enrolled: true as const, revision: runtimeState.revisions.accounts };
            })
          );
        }),
      "accounts.enrollActivate": (params) =>
        Effect.gen(function* () {
          const {
            env: daemonEnv,
            state: runtimeState,
            generations,
            auth: authHealth,
            sidecar
          } = yield* daemonAccountServices;
          const host = yield* DaemonHost;
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
          const connector = resolved.info.connector;
          const provider = connector === "cliproxy" ? "cliproxy" : kind;
          const prepared = yield* controlTry(() => {
            const seenLabels = new Set<string>();
            return params.accounts.map((account) => {
              const label =
                connector === "native"
                  ? sanitizeSubscriptionLabel(account.label)
                  : safeCliproxyLabel(account.label);
              if (label !== account.label || (connector === "native" && label.startsWith("."))) {
                throw new ControlError({
                  code: "bad_request",
                  message: "account label must already be normalized"
                });
              }
              if (seenLabels.has(label)) {
                throw new ControlError({
                  code: "bad_request",
                  message: `duplicate account label: ${label}`
                });
              }
              seenLabels.add(label);
              const directory =
                connector === "native"
                  ? defaultSubscriptionAccountDirectory(kind as SubscriptionMode, env)
                  : cliproxyAuthDirectory(env);
              const path = join(directory, `${label}.json`);
              let credential = account.credential;
              if (credential === undefined) {
                if (!existsSync(path)) {
                  throw new ControlError({
                    code: "not_found",
                    message: `${kind}/${label} is not enrolled`
                  });
                }
                try {
                  credential = JSON.parse(readFileSync(path, "utf8")) as unknown;
                } catch {
                  throw new ControlError({
                    code: "bad_request",
                    message: `${kind}/${label} has an invalid stored credential`
                  });
                }
              }
              const blob =
                connector === "native"
                  ? safeCredentialBlob(kind as SubscriptionMode, credential)
                  : safeCliproxyCredentialBlob(kind, credential);
              const content = `${JSON.stringify(blob, null, 2)}\n`;
              if (
                connector === "native" &&
                account.credential !== undefined &&
                existsSync(path) &&
                readFileSync(path, "utf8") !== content
              ) {
                throw new ControlError({
                  code: "conflict",
                  message: `${kind}/${label} is already enrolled with different credentials`
                });
              }
              return {
                label,
                directory,
                path,
                content,
                credentialProvided: account.credential !== undefined
              };
            });
          });
          yield* runtimeState.serializeEffect(
            Effect.gen(function* () {
              yield* controlTry(() => {
                for (const entry of prepared) {
                  if (!entry.credentialProvided) {
                    if (!existsSync(entry.path)) {
                      throw new ControlError({
                        code: "not_found",
                        message: `${kind}/${entry.label} is not enrolled`
                      });
                    }
                    let stored: unknown;
                    try {
                      stored = JSON.parse(readFileSync(entry.path, "utf8")) as unknown;
                    } catch {
                      throw new ControlError({
                        code: "bad_request",
                        message: `${kind}/${entry.label} has an invalid stored credential`
                      });
                    }
                    const blob =
                      connector === "native"
                        ? safeCredentialBlob(kind as SubscriptionMode, stored)
                        : safeCliproxyCredentialBlob(kind, stored);
                    entry.content = `${JSON.stringify(blob, null, 2)}\n`;
                  } else if (
                    connector === "native" &&
                    existsSync(entry.path) &&
                    readFileSync(entry.path, "utf8") !== entry.content
                  ) {
                    throw new ControlError({
                      code: "conflict",
                      message: `${kind}/${entry.label} is already enrolled with different credentials`
                    });
                  }
                }
              });
              const unchanged = prepared.every(
                (entry) =>
                  existsSync(entry.path) && readFileSync(entry.path, "utf8") === entry.content
              );
              if (
                unchanged &&
                (runtimeState.config.providers as Record<string, unknown>)[provider] !== undefined
              ) {
                return;
              }
              const raw = parseYaml(runtimeState.document) as Record<string, unknown>;
              const providers =
                typeof raw.providers === "object" &&
                raw.providers !== null &&
                !Array.isArray(raw.providers)
                  ? { ...(raw.providers as Record<string, unknown>) }
                  : {};
              providers[provider] ??= {};
              raw.providers = providers;
              const document = stringifyYaml(raw);
              const nextConfig = parseConfigDocument(document);
              const transaction = prepareAccountTransaction({
                home,
                configPath,
                accountPaths: [
                  ...prepared.map((entry) => entry.path),
                  ...(connector === "native"
                    ? [join(home, "subscriptions", "account-auth.v1.json")]
                    : [])
                ],
                accountRoots: [
                  ...new Set(prepared.map((entry) => entry.directory)),
                  ...(connector === "native" ? [join(home, "subscriptions")] : [])
                ],
                kind,
                provider,
                labels: prepared.map((entry) => entry.label)
              });
              host.onAccountTransactionPhase?.("prepared");
              let routerReplaced = false;
              const previousConfig = runtimeState.config;
              const previousDocument = runtimeState.document;
              yield* Effect.gen(function* () {
                yield* controlTry(() => {
                  for (const entry of prepared) {
                    mkdirSync(entry.directory, { recursive: true, mode: 0o700 });
                    writeFileAtomic(entry.path, entry.content, { mode: 0o600 });
                    chmodSync(entry.path, 0o600);
                  }
                  host.onAccountTransactionPhase?.("credentials-written");
                });
                yield* replaceRouter(nextConfig, document, {
                  write: true,
                  configRevision: true,
                  accountRevision: true,
                  persist: () =>
                    Effect.gen(function* () {
                      if (connector === "native") {
                        for (const entry of prepared) {
                          yield* authHealth.activateFingerprint(
                            subscriptionAccountIdentity(kind as SubscriptionMode, entry.label),
                            subscriptionCredentialFingerprint(entry.path)
                          );
                        }
                      }
                      markAccountTransactionCommitted(transaction);
                      if (connector === "cliproxy") {
                        yield* sidecar.refresh;
                      }
                      host.onAccountTransactionPhase?.("committed");
                    })
                });
                routerReplaced = true;
                host.onAccountTransactionPhase?.("router-swapped");
                yield* controlTry(() => cleanupAccountTransaction(transaction)).pipe(Effect.ignore);
              }).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    const rollbackFailures: unknown[] = [];
                    yield* Effect.try({
                      try: () => {
                        rollbackAccountTransaction(transaction, home);
                      },
                      catch: toRouteKitFailure
                    }).pipe(
                      Effect.flatMap(() => authHealth.reload),
                      Effect.catch((rollbackError) => {
                        rollbackFailures.push(rollbackError);
                        return Effect.void;
                      })
                    );
                    if (connector === "cliproxy") {
                      yield* sidecar.refresh.pipe(
                        Effect.catch((rollbackError) => {
                          rollbackFailures.push(rollbackError);
                          return Effect.void;
                        })
                      );
                    }
                    if (routerReplaced) {
                      yield* replaceRouter(previousConfig, previousDocument, { write: false }).pipe(
                        Effect.catch((rollbackError) => {
                          rollbackFailures.push(rollbackError);
                          return Effect.void;
                        })
                      );
                    }
                    if (rollbackFailures.length > 0) {
                      return yield* Effect.fail(
                        new AggregateError(
                          [error, ...rollbackFailures],
                          `could not activate ${kind}; rollback failed`
                        )
                      );
                    }
                    return yield* Effect.fail(routeKitError(error));
                  })
                )
              );
            })
          );
          return {
            enrolled: prepared.map((entry) => ({ subscriptionKind: kind, label: entry.label })),
            activated: true,
            configPath,
            configRevision: runtimeState.revisions.config,
            accountRevision: runtimeState.revisions.accounts
          };
        })
    };
  }
}
