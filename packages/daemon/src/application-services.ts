import type {
  ControlAuthorization,
  ControlIdempotencyPolicy,
  ControlMutationClassification,
  RouteKitControlHandlers,
  RouteKitControlMethod
} from "@velum-labs/routekit-control";
import { ControlMethodRegistry, routeKitControlSchemas } from "@velum-labs/routekit-control";

type MethodGroup = readonly RouteKitControlMethod[];

const ACCOUNT_METHODS = [
  "accounts.list",
  "accounts.status",
  "accounts.enroll",
  "accounts.enrollActivate",
  "accounts.remove",
  "accounts.rename",
  "accounts.sync",
  "accounts.usage",
  "accounts.resetCredits",
  "accounts.redeemReset"
] as const satisfies MethodGroup;

const PROVIDER_QUERY_METHODS = [
  "providers.status",
  "models.list",
  "models.info",
  "calls.inspect",
  "calls.leaderboard"
] as const satisfies MethodGroup;

const ROUTER_MUTATION_METHODS = [
  "daemon.reload",
  "config.update",
  "config.import",
  "providers.set"
] as const satisfies MethodGroup;

const CORE_METHOD_POLICIES = {
  "daemon.status": ["authenticated", "query", "none"],
  "daemon.roll": ["ephemeral", "mutation", "optional"],
  "daemon.prepareShutdown": ["authenticated", "mutation", "optional"],
  "config.get": ["authenticated", "query", "none"],
  "telemetry.get": ["authenticated", "query", "none"],
  "telemetry.set": ["authenticated", "mutation", "optional"],
  "telemetry.resetIdentity": ["authenticated", "mutation", "optional"],
  "telemetry.schema": ["authenticated", "query", "none"],
  "telemetry.captureCommand": ["authenticated", "query", "none"],
  "doctor.run": ["authenticated", "query", "none"],
  "launcher.prepare": ["authenticated", "query", "none"],
  "tokens.issue": ["authenticated", "mutation", "optional"],
  "tokens.list": ["authenticated", "query", "none"],
  "tokens.revoke": ["authenticated", "mutation", "optional"]
} as const satisfies Record<
  Exclude<
    RouteKitControlMethod,
    | (typeof ACCOUNT_METHODS)[number]
    | (typeof PROVIDER_QUERY_METHODS)[number]
    | (typeof ROUTER_MUTATION_METHODS)[number]
  >,
  readonly [ControlAuthorization, ControlMutationClassification, ControlIdempotencyPolicy]
>;

export type ControlRegistrationPolicy = {
  authorization: ControlAuthorization;
  mutation: ControlMutationClassification;
  idempotency: ControlIdempotencyPolicy;
};

function registerMethods(
  registry: ControlMethodRegistry,
  handlers: RouteKitControlHandlers,
  methods: MethodGroup,
  policyFor: (method: RouteKitControlMethod) => ControlRegistrationPolicy
): void {
  for (const method of methods) {
    const policy = policyFor(method);
    registry.register({
      method,
      ...routeKitControlSchemas(method),
      ...policy,
      handler: handlers[method] as never
    });
  }
}

/**
 * Owns account use-case registration. Account persistence and router
 * publication remain private implementation details of these handlers.
 */
class AccountApplicationRegistration {
  readonly #handlers: RouteKitControlHandlers;

  constructor(handlers: RouteKitControlHandlers) {
    this.#handlers = handlers;
  }

  register(registry: ControlMethodRegistry): void {
    registerMethods(registry, this.#handlers, ACCOUNT_METHODS, (method) => ({
      authorization: "authenticated",
      mutation:
        method === "accounts.list" ||
        method === "accounts.status" ||
        method === "accounts.usage" ||
        method === "accounts.resetCredits"
          ? "query"
          : "mutation",
      idempotency:
        method === "accounts.list" ||
        method === "accounts.status" ||
        method === "accounts.usage" ||
        method === "accounts.resetCredits"
          ? "none"
          : "optional"
    }));
  }
}

/** Registers the provider/catalog query handlers owned by ProviderQueryService. */
class ProviderQueryRegistration {
  readonly #handlers: RouteKitControlHandlers;

  constructor(handlers: RouteKitControlHandlers) {
    this.#handlers = handlers;
  }

  register(registry: ControlMethodRegistry): void {
    registerMethods(registry, this.#handlers, PROVIDER_QUERY_METHODS, () => ({
      authorization: "authenticated",
      mutation: "query",
      idempotency: "none"
    }));
  }
}

/** Registers the mutation handlers owned by RouterGenerationService. */
class RouterGenerationRegistration {
  readonly #handlers: RouteKitControlHandlers;

  constructor(handlers: RouteKitControlHandlers) {
    this.#handlers = handlers;
  }

  register(registry: ControlMethodRegistry): void {
    registerMethods(registry, this.#handlers, ROUTER_MUTATION_METHODS, () => ({
      authorization: "authenticated",
      mutation: "mutation",
      idempotency: "optional"
    }));
  }
}

export const DAEMON_APPLICATION_METHODS = {
  accounts: ACCOUNT_METHODS,
  providerQueries: PROVIDER_QUERY_METHODS,
  routerGenerations: ROUTER_MUTATION_METHODS
} as const;

export function createDaemonControlMethodRegistry(
  handlers: RouteKitControlHandlers
): ControlMethodRegistry {
  const registry = new ControlMethodRegistry();
  new AccountApplicationRegistration(handlers).register(registry);
  new ProviderQueryRegistration(handlers).register(registry);
  new RouterGenerationRegistration(handlers).register(registry);
  for (const [method, [authorization, mutation, idempotency]] of Object.entries(
    CORE_METHOD_POLICIES
  ) as [
    keyof typeof CORE_METHOD_POLICIES,
    (typeof CORE_METHOD_POLICIES)[keyof typeof CORE_METHOD_POLICIES]
  ][]) {
    registry.register({
      method,
      ...routeKitControlSchemas(method),
      authorization,
      mutation,
      idempotency,
      handler: handlers[method] as never
    });
  }
  return registry;
}
