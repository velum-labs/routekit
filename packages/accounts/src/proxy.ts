import { randomBytes } from "node:crypto";

import { ResourceScope } from "@velum-labs/routekit-runtime";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import type { CoordinatorResource } from "./account-set/types.js";
import { AccountActivityCoordinator } from "./activity.js";
import type { SubscriptionAccountConfigs } from "./gateway.js";
import { closeSubscriptionAccountSets, openSubscriptionRelays } from "./gateway.js";
import type { SubscriptionGatewayFactory, SubscriptionGatewayOptions } from "./gateway-port.js";
import type { SubscriptionRelayDialect } from "./relay.js";
import { RelayOnlyBackend } from "./relay.js";
import { collectSubscriptionUsage } from "./usage.js";
import type { SubscriptionUsageResponse } from "./wire.js";
import { snapshotsToUsage } from "./wire.js";

export type StartSubscriptionProxyOptions = {
  /** Per-provider account-set configuration (source + selection policy). */
  accounts: SubscriptionAccountConfigs;
  host?: string;
  port?: number;
  /** Ingress proxy token clients must present; generated when omitted. */
  token?: string;
  /** Gateway constructor supplied by the embedding host. */
  gatewayFactory: SubscriptionGatewayFactory;
  /** Account activity lifetime, explicit when shared with a daemon generation. */
  activity?: CoordinatorResource<AccountActivityCoordinator>;
};

/** A running subscription proxy: a native reverse proxy over pooled accounts. */
export type SubscriptionProxy = {
  url(): string;
  port(): number;
  /** The ingress token clients present (and the proxy verifies). */
  readonly token: string;
  /** Which provider relays are live behind this proxy. */
  readonly providers: readonly SubscriptionRelayDialect[];
  /** The live per-account usage snapshot (in-process; no self HTTP call). */
  usage(): SubscriptionUsageResponse;
  close(): Promise<void>;
};

/**
 * Raised when no provider has a usable account, so the proxy would serve
 * nothing. Callers surface the enrollment hint.
 */
export class NoSubscriptionAccountsError extends Error {
  constructor() {
    super(
      "no subscription accounts are available; sign in with the official CLI or enroll an account"
    );
    this.name = "NoSubscriptionAccountsError";
  }
}

function generateToken(): string {
  return `rk-proxy-${randomBytes(24).toString("base64url")}`;
}

/**
 * Start a provider-native subscription proxy in one call: open the configured
 * account sets into relays, front them with a relay-only gateway, and return a
 * handle exposing the URL, ingress token, live usage snapshot, and teardown.
 * A product CLI can be a thin wrapper over this.
 */
export async function startSubscriptionProxy(
  options: StartSubscriptionProxyOptions
): Promise<SubscriptionProxy> {
  const startup = new ResourceScope();
  try {
    const activity =
      options.activity === undefined
        ? startup.own(await runRouteKitEffect(AccountActivityCoordinator.open()))
        : options.activity.ownership === "owned"
          ? startup.own(options.activity.resource)
          : startup.borrow(options.activity.resource);
    const { relays, accountSets } = await openSubscriptionRelays({
      accounts: options.accounts,
      activity: { resource: activity, ownership: "borrowed" }
    });
    startup.defer(async () => await closeSubscriptionAccountSets(accountSets));
    const live = Object.entries(relays).filter(
      (
        entry
      ): entry is [
        SubscriptionRelayDialect,
        NonNullable<(typeof relays)[SubscriptionRelayDialect]>
      ] => entry[1] !== undefined
    );
    if (live.length === 0) throw new NoSubscriptionAccountsError();

    const token = options.token ?? generateToken();
    const gatewayOptions: SubscriptionGatewayOptions = {
      backend: new RelayOnlyBackend(),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      authToken: token,
      providerRelays: relays,
      usage: async () => await collectSubscriptionUsage(accountSets)
    };
    const gateway = startup.own(await options.gatewayFactory(gatewayOptions));
    const liveResources = new ResourceScope();
    startup.transferTo(liveResources);

    return {
      url: () => gateway.url(),
      port: () => gateway.port(),
      token,
      providers: live.map(([dialect]) => dialect),
      usage: () => snapshotsToUsage(live.map(([, ports]) => ports.request.snapshot?.())),
      close: async () => await liveResources.dispose()
    };
  } catch (error) {
    try {
      await startup.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "subscription proxy startup failed");
    }
    throw error;
  }
}
