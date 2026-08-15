import { randomBytes } from "node:crypto";

import {
  EffectResourceScope,
  routeKitError,
  runRouteKitEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Data, Effect } from "effect";

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
export class NoSubscriptionAccountsError extends Data.TaggedError("NoSubscriptionAccountsError")<{
  readonly message: string;
}> {
  constructor() {
    super({
      message:
        "no subscription accounts are available; sign in with the official CLI or enroll an account"
    });
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
export function startSubscriptionProxy(options: StartSubscriptionProxyOptions) {
  return Effect.gen(function* () {
    const startup = new EffectResourceScope();
    const failedStartup = (error: unknown) =>
      startup.dispose().pipe(
        Effect.matchEffect({
          onFailure: (cleanupError) =>
            Effect.fail(
              new AggregateError([error, cleanupError], "subscription proxy startup failed")
            ),
          onSuccess: () => Effect.fail(routeKitError(error))
        })
      );
    const activity =
      options.activity === undefined
        ? yield* startup.own(yield* AccountActivityCoordinator.open())
        : options.activity.ownership === "owned"
          ? yield* startup.own(options.activity.resource)
          : yield* startup.borrow(options.activity.resource);
    const { relays, accountSets } = yield* openSubscriptionRelays({
      accounts: options.accounts,
      activity: { resource: activity, ownership: "borrowed" }
    }).pipe(Effect.catch(failedStartup));
    yield* startup.deferEffect(closeSubscriptionAccountSets(accountSets));
    const live = Object.entries(relays).filter(
      (
        entry
      ): entry is [
        SubscriptionRelayDialect,
        NonNullable<(typeof relays)[SubscriptionRelayDialect]>
      ] => entry[1] !== undefined
    );
    if (live.length === 0) {
      return yield* failedStartup(new NoSubscriptionAccountsError());
    }

    const token = options.token ?? generateToken();
    const gatewayOptions: SubscriptionGatewayOptions = {
      backend: new RelayOnlyBackend(),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      authToken: token,
      providerRelays: relays,
      usage: () => collectSubscriptionUsage(accountSets)
    };
    const gateway = yield* Effect.tryPromise({
      try: () => options.gatewayFactory(gatewayOptions),
      catch: toRouteKitFailure
    }).pipe(Effect.catch(failedStartup));
    yield* startup.own(gateway).pipe(Effect.catch(failedStartup));
    const liveResources = new EffectResourceScope();
    yield* startup.transferTo(liveResources);

    return {
      url: () => gateway.url(),
      port: () => gateway.port(),
      token,
      providers: live.map(([dialect]) => dialect),
      usage: () => snapshotsToUsage(live.map(([, ports]) => ports.request.snapshot?.())),
      close: () => runRouteKitEffect(liveResources.dispose())
    } satisfies SubscriptionProxy;
  });
}
