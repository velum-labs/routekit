import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import {
  ControlMethodRegistry,
  controlAuthorization,
  controlIdempotency,
  controlMutation,
  ROUTEKIT_CONTROL_METHODS,
  routeKitControlSchemas
} from "@velum-labs/routekit-control";

/**
 * Builds the daemon's control registry straight from the protocol method table.
 *
 * Authorization, mutation classification, and idempotency policy are protocol
 * facts, not daemon opinions, so the daemon binds handlers and inherits the
 * rest. A method added to the table is registered here with no edit.
 */
export function createDaemonControlMethodRegistry(
  handlers: RouteKitControlHandlers
): ControlMethodRegistry {
  const registry = new ControlMethodRegistry();
  for (const method of ROUTEKIT_CONTROL_METHODS) {
    registry.register({
      method,
      ...routeKitControlSchemas(method),
      authorization: controlAuthorization(method),
      mutation: controlMutation(method),
      idempotency: controlIdempotency(method),
      handler: handlers[method] as never
    });
  }
  return registry;
}
