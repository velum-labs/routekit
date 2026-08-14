import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
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
import { routeKitError, runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AccountApplicationServiceOptions } from "./account-application-options.js";
import {
  cleanupAccountTransaction,
  markAccountTransactionCommitted,
  prepareAccountTransaction,
  rollbackAccountTransaction
} from "./account-transaction.js";
import { controlTryPromise } from "./control-effect.js";
import { accountEntries, parseConfigDocument } from "./daemon-maintenance.js";

type AccountMutationHandlers = Pick<
  EffectRouteKitControlHandlers,
  | "accounts.remove"
  | "accounts.rename"
  | "accounts.sync"
  | "accounts.resetCredits"
  | "accounts.redeemReset"
>;

/** Owns account removal, rename, sync, and credit redemption. */
export class AccountMutationService {
  constructor(private readonly options: AccountApplicationServiceOptions) {}

  handlers(): AccountMutationHandlers {
    const {
      env,
      home,
      configPath,
      runtimeState,
      sidecar,
      activity,
      authHealth,
      activeRouter,
      serializeMutation,
      replaceRouter,
      onTransactionPhase
    } = this.options;
    return {
      "accounts.remove": (params) =>
        controlTryPromise(async () => {
          const resolved = resolveAccountConnector(params.kind);
          if (resolved === undefined) {
            throw new ControlError({
              code: "bad_request",
              message: `unknown subscription kind: ${params.kind}`
            });
          }
          const kind = resolved.kind;
          let removed = false;
          await serializeMutation(async () => {
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
              const config = disableProvider ? parseConfigDocument(document) : runtimeState.config;
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
              try {
                removed = removeSubscriptionAccount(nativeKind, params.label, {
                  accountsDirectory: dirname(nativePath)
                }).removed;
                if (!removed) {
                  cleanupAccountTransaction(transaction);
                  return;
                }
                await replaceRouter(config, document, {
                  write: disableProvider,
                  configRevision: disableProvider,
                  accountRevision: true,
                  persist: async () => {
                    await runRouteKitEffect(
                      activity.remove(subscriptionAccountIdentity(nativeKind, params.label))
                    );
                    await runRouteKitEffect(
                      authHealth.remove(subscriptionAccountIdentity(nativeKind, params.label))
                    );
                    markAccountTransactionCommitted(transaction);
                  }
                });
                try {
                  cleanupAccountTransaction(transaction);
                } catch {
                  // Committed transactions are cleanup-only during recovery.
                }
              } catch (error) {
                try {
                  rollbackAccountTransaction(transaction, home);
                  await runRouteKitEffect(activity.reload());
                  await runRouteKitEffect(authHealth.reload());
                } catch (rollbackError) {
                  throw new AggregateError(
                    [error, rollbackError],
                    `could not remove ${kind}/${params.label}; rollback failed`
                  );
                }
                throw error;
              }
              return;
            }
            const entry = cliproxyAccountEntries(env).find(
              (candidate) =>
                candidate.label === params.label && cliproxyAccountMatchesKind(candidate, kind)
            );
            if (entry === undefined) return;
            const previous = readFileSync(entry.path);
            removed = removeCliproxyAccount(params.label, env).removed;
            if (!removed) return;
            try {
              await runRouteKitEffect(sidecar.refresh());
              await replaceRouter(runtimeState.config, runtimeState.document, {
                write: false,
                accountRevision: true
              });
            } catch (error) {
              writeFileAtomic(entry.path, previous.toString("utf8"), { mode: 0o600 });
              chmodSync(entry.path, 0o600);
              try {
                await runRouteKitEffect(sidecar.refresh());
              } catch {
                // Best-effort process rollback; preserve the mutation failure.
              }
              throw error;
            }
          });
          return { removed, revision: runtimeState.revisions.accounts };
        }),
      "accounts.rename": (params) =>
        controlTryPromise(async () => {
          const resolved = resolveAccountConnector(params.kind);
          if (resolved === undefined || resolved.info.connector !== "native") {
            throw new ControlError({
              code: "bad_request",
              message: "account rename supports only claude-code and codex"
            });
          }
          const kind = resolved.kind as SubscriptionMode;
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
          await serializeMutation(async () => {
            const directory = defaultSubscriptionAccountDirectory(kind, env);
            const sourcePath = join(directory, `${params.source}.json`);
            const targetPath = join(directory, `${params.target}.json`);
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
            try {
              renameSubscriptionAccount(kind, params.source, params.target, {
                accountsDirectory: directory
              });
              const tracker = await runRouteKitEffect(
                RateLimitTracker.open(join(directory, ".state.json"), kind)
              );
              await runRouteKitEffect(tracker.renameMember(params.source, params.target));
              onTransactionPhase?.("credentials-written");
              await replaceRouter(runtimeState.config, runtimeState.document, {
                write: false,
                accountRevision: true,
                persist: async () => {
                  await runRouteKitEffect(
                    activity.rename(
                      subscriptionAccountIdentity(kind, params.source),
                      subscriptionAccountIdentity(kind, params.target)
                    )
                  );
                  await runRouteKitEffect(
                    authHealth.rename(
                      subscriptionAccountIdentity(kind, params.source),
                      subscriptionAccountIdentity(kind, params.target)
                    )
                  );
                  markAccountTransactionCommitted(transaction);
                }
              });
              try {
                cleanupAccountTransaction(transaction);
              } catch {
                // Committed transactions are cleanup-only during recovery.
              }
            } catch (error) {
              try {
                rollbackAccountTransaction(transaction, home);
                await runRouteKitEffect(activity.reload());
                await runRouteKitEffect(authHealth.reload());
              } catch (rollbackError) {
                throw new AggregateError(
                  [error, rollbackError],
                  `could not rename ${kind}/${params.source}; rollback failed`
                );
              }
              throw error;
            }
          });
          return { renamed: true, revision: runtimeState.revisions.accounts };
        }),
      "accounts.sync": () =>
        controlTryPromise(async () => {
          await serializeMutation(async () => {
            await runRouteKitEffect(sidecar.refresh());
            await replaceRouter(runtimeState.config, runtimeState.document, {
              write: false,
              accountRevision: true
            });
          });
          return { synced: true, revision: runtimeState.revisions.accounts };
        }),
      "accounts.resetCredits": (params, context) =>
        activeRouter()
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
          ),
      "accounts.redeemReset": (params, context) =>
        activeRouter()
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
          )
    };
  }
}
