import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AccountActivityCoordinator,
  type AccountAuthCoordinator,
  cliproxyAccountEntries,
  cliproxyAccountMatchesKind,
  cliproxyAuthDirectory,
  defaultSubscriptionAccountDirectory,
  RateLimitTracker,
  removeCliproxyAccount,
  removeSubscriptionAccount,
  renameSubscriptionAccount,
  sanitizeSubscriptionLabel,
  subscriptionAccountIdentity,
  subscriptionCredentialFingerprint
} from "@velum-labs/routekit-accounts";
import type { RouterConfig } from "@velum-labs/routekit-config";
import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { resolveAccountConnector } from "@velum-labs/routekit-registry";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { ControlError, writeFileAtomic } from "@velum-labs/routekit-runtime";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type AccountTransactionRecovery,
  cleanupAccountTransaction,
  markAccountTransactionCommitted,
  prepareAccountTransaction,
  rollbackAccountTransaction
} from "./account-transaction.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import type { DaemonGenerationMutation } from "./daemon-generations.js";
import {
  accountEntries,
  parseConfigDocument,
  safeCliproxyCredentialBlob,
  safeCliproxyLabel,
  safeCredentialBlob
} from "./daemon-maintenance.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";

type AccountHandlers = Pick<
  RouteKitControlHandlers,
  | "accounts.list"
  | "accounts.status"
  | "accounts.enroll"
  | "accounts.enrollActivate"
  | "accounts.remove"
  | "accounts.rename"
  | "accounts.sync"
  | "accounts.usage"
  | "accounts.resetCredits"
  | "accounts.redeemReset"
>;

export type AccountApplicationServiceOptions = {
  env: NodeJS.ProcessEnv;
  home: string;
  configPath: string;
  runtimeState: DaemonRuntimeState;
  sidecar: CliproxySidecar;
  activity: AccountActivityCoordinator;
  authHealth: AccountAuthCoordinator;
  recovery: AccountTransactionRecovery;
  activeRouter(): RunningRouter;
  serializeMutation<T>(operation: () => Promise<T>): Promise<T>;
  replaceRouter(
    config: RouterConfig,
    document: string,
    mutation: DaemonGenerationMutation
  ): Promise<void>;
  onTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};

/** Owns account enrollment, activation, mutation, usage, and recovery use cases. */
export class AccountApplicationService {
  constructor(private readonly options: AccountApplicationServiceOptions) {}

  handlers(): AccountHandlers {
    const {
      env,
      home,
      configPath,
      runtimeState,
      sidecar,
      activity,
      authHealth,
      recovery,
      activeRouter,
      serializeMutation,
      replaceRouter,
      onTransactionPhase
    } = this.options;
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
      "accounts.enroll": async (params) => {
        await serializeMutation(async () => {
          const label = sanitizeSubscriptionLabel(params.label);
          if (label !== params.label || label.startsWith(".")) {
            throw new ControlError({
              code: "bad_request",
              message: "account label must already be normalized"
            });
          }
          const directory = defaultSubscriptionAccountDirectory(params.kind, env);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, `${label}.json`);
          if (existsSync(path)) {
            throw new ControlError({
              code: "conflict",
              message: `${params.kind}/${label} is already enrolled; remove it before enrolling again`
            });
          }
          writeFileAtomic(
            path,
            `${JSON.stringify(safeCredentialBlob(params.kind, params.credential), null, 2)}\n`,
            { mode: 0o600 }
          );
          chmodSync(path, 0o600);
          try {
            await replaceRouter(runtimeState.config, runtimeState.document, {
              write: false,
              accountRevision: true
            });
          } catch (error) {
            rmSync(path, { force: true });
            throw error;
          }
        });
        return { enrolled: true, revision: runtimeState.revisions.accounts };
      },
      "accounts.enrollActivate": async (params) => {
        const resolved = resolveAccountConnector(params.kind);
        if (resolved === undefined) {
          throw new ControlError({
            code: "bad_request",
            message: `unknown subscription kind: ${params.kind}`
          });
        }
        const kind = resolved.kind;
        const connector = resolved.info.connector;
        const provider = connector === "cliproxy" ? "cliproxy" : kind;
        const seenLabels = new Set<string>();
        const prepared = params.accounts.map((account) => {
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
        await serializeMutation(async () => {
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
          const unchanged = prepared.every(
            (entry) => existsSync(entry.path) && readFileSync(entry.path, "utf8") === entry.content
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
          onTransactionPhase?.("prepared");
          let routerReplaced = false;
          const previousConfig = runtimeState.config;
          const previousDocument = runtimeState.document;
          try {
            for (const entry of prepared) {
              mkdirSync(entry.directory, { recursive: true, mode: 0o700 });
              writeFileAtomic(entry.path, entry.content, { mode: 0o600 });
              chmodSync(entry.path, 0o600);
            }
            onTransactionPhase?.("credentials-written");
            await replaceRouter(nextConfig, document, {
              write: true,
              configRevision: true,
              accountRevision: true,
              persist: async () => {
                if (connector === "native") {
                  for (const entry of prepared) {
                    authHealth.activateFingerprint(
                      subscriptionAccountIdentity(kind as SubscriptionMode, entry.label),
                      subscriptionCredentialFingerprint(entry.path)
                    );
                  }
                }
                markAccountTransactionCommitted(transaction);
                if (connector === "cliproxy") await sidecar.refresh();
                onTransactionPhase?.("committed");
              }
            });
            routerReplaced = true;
            onTransactionPhase?.("router-swapped");
            try {
              cleanupAccountTransaction(transaction);
            } catch {
              // Committed transactions are cleanup-only during recovery.
            }
          } catch (error) {
            const rollbackFailures: unknown[] = [];
            try {
              rollbackAccountTransaction(transaction, home);
              authHealth.reload();
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
            if (connector === "cliproxy") {
              try {
                await sidecar.refresh();
              } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
              }
            }
            if (routerReplaced) {
              try {
                await replaceRouter(previousConfig, previousDocument, { write: false });
              } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
              }
            }
            if (rollbackFailures.length > 0) {
              throw new AggregateError(
                [error, ...rollbackFailures],
                `could not activate ${kind}; rollback failed`
              );
            }
            throw error;
          }
        });
        return {
          enrolled: prepared.map((entry) => ({ subscriptionKind: kind, label: entry.label })),
          activated: true,
          configPath,
          configRevision: runtimeState.revisions.config,
          accountRevision: runtimeState.revisions.accounts
        };
      },
      "accounts.remove": async (params) => {
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
                persist: () => {
                  activity.remove(subscriptionAccountIdentity(nativeKind, params.label));
                  authHealth.remove(subscriptionAccountIdentity(nativeKind, params.label));
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
                activity.reload();
                authHealth.reload();
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
            await sidecar.refresh();
            await replaceRouter(runtimeState.config, runtimeState.document, {
              write: false,
              accountRevision: true
            });
          } catch (error) {
            writeFileAtomic(entry.path, previous.toString("utf8"), { mode: 0o600 });
            chmodSync(entry.path, 0o600);
            try {
              await sidecar.refresh();
            } catch {
              // Best-effort process rollback; preserve the mutation failure.
            }
            throw error;
          }
        });
        return { removed, revision: runtimeState.revisions.accounts };
      },
      "accounts.rename": async (params) => {
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
            new RateLimitTracker(join(directory, ".state.json"), kind).renameMember(
              params.source,
              params.target
            );
            onTransactionPhase?.("credentials-written");
            await replaceRouter(runtimeState.config, runtimeState.document, {
              write: false,
              accountRevision: true,
              persist: () => {
                activity.rename(
                  subscriptionAccountIdentity(kind, params.source),
                  subscriptionAccountIdentity(kind, params.target)
                );
                authHealth.rename(
                  subscriptionAccountIdentity(kind, params.source),
                  subscriptionAccountIdentity(kind, params.target)
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
              activity.reload();
              authHealth.reload();
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
      },
      "accounts.sync": async () => {
        await serializeMutation(async () => {
          await sidecar.refresh();
          await replaceRouter(runtimeState.config, runtimeState.document, {
            write: false,
            accountRevision: true
          });
        });
        return { synced: true, revision: runtimeState.revisions.accounts };
      },
      "accounts.usage": async (_params, context) => await activeRouter().usage(context.signal),
      "accounts.resetCredits": async (params, context) => {
        try {
          return {
            kind: params.kind,
            label: params.label,
            resetCredits: await activeRouter().listResetCredits(
              params.kind,
              params.label,
              context.signal
            )
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("is not enrolled") || message.includes("no codex account pool")) {
            throw new ControlError({ code: "not_found", message });
          }
          throw error;
        }
      },
      "accounts.redeemReset": async (params, context) => {
        try {
          const result = await activeRouter().redeemReset(
            {
              kind: params.kind,
              label: params.label,
              ...(params.creditId !== undefined ? { creditId: params.creditId } : {}),
              ...(params.redeemRequestId !== undefined
                ? { redeemRequestId: params.redeemRequestId }
                : {})
            },
            context.signal
          );
          return {
            ok: result.ok,
            code: result.code,
            kind: "codex",
            label: result.label,
            redeemRequestId: result.redeemRequestId,
            ...(result.creditId !== undefined ? { creditId: result.creditId } : {}),
            ...(result.windowsReset !== undefined ? { windowsReset: result.windowsReset } : {}),
            usage: result.usage
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("is not enrolled") || message.includes("no redeemable")) {
            throw new ControlError({ code: "not_found", message });
          }
          if (
            message.includes("does not support") ||
            message.includes("no codex account pool") ||
            message.includes("creditId must not be empty") ||
            message.includes("account label is required")
          ) {
            throw new ControlError({ code: "bad_request", message });
          }
          throw new ControlError({ code: "internal", message });
        }
      }
    };
  }
}
