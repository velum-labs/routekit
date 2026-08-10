import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  AccountActivityCoordinator,
  type AccountLimits,
  RateLimitTracker,
  type ResetCreditSnapshot,
  SUBSCRIPTION_SSE_BUFFER_CAP_BYTES,
  SubscriptionAccountSet,
  SubscriptionAccountSetAuthError,
  type SubscriptionCredential,
  type SubscriptionProvider,
  SubscriptionProviderRequestError,
  SubscriptionRefreshError,
  sanitizeSubscriptionLabel,
  subscriptionProvider
} from "../index.js";

type FakeCredentialFile = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

type FakeProviderState = {
  refreshes: number;
  failRefreshTokens?: Set<string>;
  usageCalls?: number;
  failUsage?: boolean;
  failResetCredits?: boolean;
  resetCredits?: ResetCreditSnapshot;
  consumeCode?: string;
  consumeCalls?: number;
  usageLimits?: AccountLimits;
};

function fakeProvider(
  state: FakeProviderState,
  modelsByToken: Readonly<Record<string, readonly string[]>> = {},
  mode: "codex" | "claude-code" = "codex"
): SubscriptionProvider {
  return {
    mode,
    upstreamBaseUrl: "https://example.invalid",
    requestPath: mode === "codex" ? "/responses" : "/v1/messages",
    async discoverModels(credential) {
      return modelsByToken[credential.accessToken] ?? ["gpt-5.3-codex"];
    },
    async loadCredential(path) {
      const raw = JSON.parse(await readFile(path, "utf8")) as FakeCredentialFile;
      return {
        mode,
        sourcePath: path,
        accessToken: raw.accessToken,
        ...(raw.refreshToken !== undefined ? { refreshToken: raw.refreshToken } : {}),
        ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt } : {})
      };
    },
    authHeaders: (credential) => ({ authorization: `Bearer ${credential.accessToken}` }),
    async refresh(credential) {
      state.refreshes += 1;
      if (state.failRefreshTokens?.has(credential.accessToken) === true) {
        throw new SubscriptionRefreshError({
          kind: "permanent",
          status: 401,
          reasonCode: "invalid_token"
        });
      }
      return {
        ...credential,
        accessToken: `${credential.accessToken}-refreshed`,
        expiresAt: Date.now() / 1000 + 3600
      };
    },
    async fetchUsage() {
      state.usageCalls = (state.usageCalls ?? 0) + 1;
      if (state.failUsage === true) throw new Error("usage unavailable");
      if (state.usageLimits !== undefined) return state.usageLimits;
      return {
        windows: {},
        observedAt: Date.now() / 1000,
        source: "usage",
        completeness: "snapshot"
      };
    },
    async fetchResetCredits() {
      if (state.failResetCredits === true) throw new Error("reset credits unavailable");
      return (
        state.resetCredits ?? { observedAt: Date.now() / 1000, availableCount: 0, credits: [] }
      );
    },
    async consumeResetCredit(_credential, input) {
      state.consumeCalls = (state.consumeCalls ?? 0) + 1;
      const code = state.consumeCode ?? "reset";
      if (code === "reset") {
        state.usageLimits = {
          windows: {
            primary: {
              utilization: 0.01,
              observedAt: Date.now() / 1000,
              source: "usage"
            }
          },
          resetCredits: { observedAt: Date.now() / 1000, availableCount: 0, credits: [] },
          observedAt: Date.now() / 1000,
          source: "usage",
          completeness: "snapshot"
        };
        state.resetCredits = { observedAt: Date.now() / 1000, availableCount: 0, credits: [] };
      }
      return {
        ok: code === "reset",
        code,
        redeemRequestId: input.redeemRequestId,
        ...(input.creditId !== undefined ? { creditId: input.creditId } : {}),
        ...(code === "reset" ? { windowsReset: 1 } : {})
      };
    },
    async fetchAdminUsageCost() {
      return { usage: {}, cost: {} };
    },
    parseLimits(headers) {
      const value = headers.get("x-test-utilization");
      if (value === null) return undefined;
      const observedAt = Date.now() / 1000;
      const limits: AccountLimits = {
        windows: {
          primary: {
            utilization: Number(value),
            observedAt,
            source: "headers"
          }
        },
        observedAt,
        source: "headers",
        completeness: "partial"
      };
      return limits;
    },
    parseStreamEvent: () => undefined,
    classify(status, _headers, body) {
      if (status === 401) {
        return {
          category: "auth_permanent",
          scope: "credential",
          status,
          message: "unauthorized"
        };
      }
      if (status === 403) {
        const code =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "object" &&
          body.error !== null &&
          "code" in body.error &&
          typeof body.error.code === "string"
            ? body.error.code
            : undefined;
        return {
          category: code === "invalidated_token" ? "auth_permanent" : "unknown",
          scope:
            code === "invalidated_token"
              ? "credential"
              : code === "model_access_denied"
                ? "member_model"
                : "request",
          status,
          message: "forbidden",
          ...(code !== undefined ? { code } : {})
        };
      }
      if (status !== 429) return undefined;
      const quota =
        typeof body === "object" && body !== null && "quota" in body && body.quota === true;
      return {
        category: quota ? "quota_exhausted" : "transient",
        message: "limited",
        ...(quota ? { resetsAt: Date.now() / 1000 + 3600 } : {})
      };
    }
  };
}

function writeMember(directory: string, name: string, credential: FakeCredentialFile): void {
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(credential));
}

type DiscoveryResult = Awaited<ReturnType<SubscriptionProvider["discoverModels"]>>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value);
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function reasoningModel(effort: string): DiscoveryResult {
  return [
    {
      id: "gpt-shared",
      createdAt: 200,
      providerPriority: 1,
      reasoning: {
        status: "supported",
        efforts: [{ id: effort }],
        provenance: "provider"
      }
    }
  ];
}

function healthyUsage(completeness: "snapshot" | "partial" = "snapshot"): AccountLimits {
  const observedAt = Date.now() / 1000;
  return {
    windows: {
      primary: { utilization: 0.1, observedAt, source: "usage" }
    },
    observedAt,
    source: "usage",
    completeness
  };
}

function fullWindowUsageLimits(hasCredits: boolean): AccountLimits {
  const observedAt = Date.now() / 1000;
  return {
    windows: {
      primary: {
        utilization: 1,
        resetsAt: observedAt + 604_800,
        observedAt,
        source: "usage"
      }
    },
    credits: { hasCredits, unlimited: false },
    observedAt,
    source: "usage",
    completeness: "snapshot"
  };
}

function codexSse(event: string, payload: unknown): Response {
  return new Response(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { "content-type": "text/event-stream" }
  });
}

/**
 * Reads the state file directly. Trackers share mutable state per path, so
 * constructing one would re-read memory instead of proving persistence.
 */
async function persistedCoolingUntil(statePath: string, id: string): Promise<number | undefined> {
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
    members: Array<{ id: string; coolingUntil?: number }>;
  };
  return parsed.members.find((member) => member.id === id)?.coolingUntil;
}

async function quotaCool(pool: SubscriptionAccountSet, model: string): Promise<void> {
  await assert.rejects(
    pool.execute(model, () =>
      Promise.resolve(
        new Response(JSON.stringify({ quota: true }), {
          status: 429,
          headers: { "content-type": "application/json" }
        })
      )
    ),
    /subscription pool members are unavailable/
  );
}


export {
  AccountActivityCoordinator,
  RateLimitTracker,
  SUBSCRIPTION_SSE_BUFFER_CAP_BYTES,
  SubscriptionAccountSet,
  SubscriptionAccountSetAuthError,
  SubscriptionProviderRequestError,
  SubscriptionRefreshError,
  sanitizeSubscriptionLabel,
  subscriptionProvider
};
export type { AccountLimits, ResetCreditSnapshot, SubscriptionCredential, SubscriptionProvider };
export type { FakeCredentialFile, FakeProviderState, DiscoveryResult };
export {
  codexSse,
  fakeProvider,
  fullWindowUsageLimits,
  healthyUsage,
  deferred,
  persistedCoolingUntil,
  quotaCool,
  reasoningModel,
  waitFor,
  writeMember
};
