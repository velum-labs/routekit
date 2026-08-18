import { randomBytes } from "node:crypto";

import {
  type RouteKitPlatform,
  routeKitError,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Cause, Context, Data, Effect, Exit, Scope } from "effect";

import type { CoordinatorResource } from "./account-set/types.js";
import {
  AccountActivityCoordinator,
  type AccountActivityService,
  accountActivityService
} from "./activity.js";
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
  activity?: CoordinatorResource<AccountActivityCoordinator | AccountActivityService>;
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
  readonly close: Effect.Effect<void, unknown, RouteKitPlatform>;
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

type AcquiredSubscriptionProxy = Omit<SubscriptionProxy, "close">;

function addOwnedFinalizer(
  scope: Scope.Closeable,
  platform: Context.Context<RouteKitPlatform>,
  closeErrors: unknown[],
  finalizer: Effect.Effect<void, unknown, RouteKitPlatform>
): Effect.Effect<void> {
  return Scope.addFinalizer(
    scope,
    Effect.exit(finalizer.pipe(Effect.provide(platform))).pipe(
      Effect.flatMap((closed) =>
        Exit.isFailure(closed)
          ? Effect.sync(() => {
              closeErrors.push(Cause.squash(closed.cause));
            })
          : Effect.void
      )
    )
  );
}

function proxyCloseError(closeErrors: readonly unknown[]): Error | undefined {
  if (closeErrors.length === 0) return undefined;
  return closeErrors.length === 1
    ? toRouteKitFailure(closeErrors[0])
    : new AggregateError(closeErrors, "subscription proxy cleanup failed");
}

const acquireSubscriptionProxy = Effect.fn("SubscriptionProxy.acquire")(function* (
  options: StartSubscriptionProxyOptions,
  scope: Scope.Closeable,
  platform: Context.Context<RouteKitPlatform>,
  closeErrors: unknown[]
): Effect.fn.Return<AcquiredSubscriptionProxy, Error, RouteKitPlatform> {
  const activityResource =
    options.activity === undefined
      ? yield* AccountActivityCoordinator.open()
      : options.activity.resource;
  if (options.activity === undefined || options.activity.ownership === "owned") {
    yield* addOwnedFinalizer(
      scope,
      platform,
      closeErrors,
      accountActivityService(activityResource).close
    );
  }
  const activity = accountActivityService(activityResource);
  const { relays, accountSets } = yield* openSubscriptionRelays({
    accounts: options.accounts,
    activity: { resource: activity, ownership: "borrowed" }
  });
  yield* addOwnedFinalizer(scope, platform, closeErrors, closeSubscriptionAccountSets(accountSets));
  const live = Object.entries(relays).filter(
    (
      entry
    ): entry is [
      SubscriptionRelayDialect,
      NonNullable<(typeof relays)[SubscriptionRelayDialect]>
    ] => entry[1] !== undefined
  );
  if (live.length === 0) {
    return yield* new NoSubscriptionAccountsError();
  }

  const token = options.token ?? generateToken();
  const gatewayOptions: SubscriptionGatewayOptions = {
    backend: new RelayOnlyBackend(),
    backendOwnership: "borrowed",
    relayOwnership: "borrowed",
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    authToken: token,
    providerRelays: relays,
    usage: () => collectSubscriptionUsage(accountSets)
  };
  const gateway = yield* options.gatewayFactory(gatewayOptions);
  yield* addOwnedFinalizer(scope, platform, closeErrors, gateway.close);

  return {
    url: () => gateway.url(),
    port: () => gateway.port(),
    token,
    providers: live.map(([dialect]) => dialect),
    usage: () => snapshotsToUsage(live.map(([, ports]) => ports.request.snapshot?.()))
  } satisfies AcquiredSubscriptionProxy;
});

/**
 * Start a provider-native subscription proxy in one call: open the configured
 * account sets into relays, front them with a relay-only gateway, and return a
 * handle exposing the URL, ingress token, live usage snapshot, and teardown.
 * A product CLI can be a thin wrapper over this.
 */
export function startSubscriptionProxy(options: StartSubscriptionProxyOptions) {
  return Effect.gen(function* () {
    const platform = yield* Effect.context<RouteKitPlatform>();
    const scope = yield* Scope.make("sequential");
    const closeErrors: unknown[] = [];
    const opened = yield* Effect.exit(
      acquireSubscriptionProxy(options, scope, platform, closeErrors)
    );
    if (Exit.isFailure(opened)) {
      yield* Scope.close(scope, opened);
      const startupError = Cause.squash(opened.cause);
      return yield* Effect.fail(
        closeErrors.length === 0
          ? routeKitError(startupError)
          : new AggregateError(
              [routeKitError(startupError), ...closeErrors],
              "subscription proxy startup failed and cleanup was incomplete"
            )
      );
    }
    const close = Scope.close(scope, Exit.void).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const error = proxyCloseError(closeErrors);
          return error === undefined ? Effect.void : Effect.fail(error);
        })
      )
    );
    return { ...opened.value, close };
  });
}
