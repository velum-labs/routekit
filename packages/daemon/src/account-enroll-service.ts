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
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AccountApplicationServiceOptions } from "./account-application-options.js";
import { controlTryPromise } from "./control-effect.js";
import {
  cleanupAccountTransaction,
  markAccountTransactionCommitted,
  prepareAccountTransaction,
  rollbackAccountTransaction
} from "./account-transaction.js";
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
  constructor(private readonly options: AccountApplicationServiceOptions) {}

  handlers(): AccountEnrollHandlers {
    const {
      env,
      home,
      configPath,
      runtimeState,
      sidecar,
      authHealth,
      serializeMutation,
      replaceRouter,
      onTransactionPhase
    } = this.options;
    return {
      "accounts.enroll": (params) =>
        controlTryPromise(async () => {
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
      }),
      "accounts.enrollActivate": (params) =>
        controlTryPromise(async () => {
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
                    await runRouteKitEffect(
                      authHealth.activateFingerprint(
                        subscriptionAccountIdentity(kind as SubscriptionMode, entry.label),
                        subscriptionCredentialFingerprint(entry.path)
                      )
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
      })
    };
  }
}
