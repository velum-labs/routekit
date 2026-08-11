import type { ControlHandlerContext } from "@velum-labs/routekit-runtime";
import type {
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams,
  RouteKitControlResults
} from "./protocol.js";

export type ControlAuthorization = "authenticated" | "ephemeral";
export type ControlMutationClassification = "query" | "mutation";
export type ControlIdempotencyPolicy = "none" | "optional" | "required";

export type ControlSchema<T> = {
  readonly name: string;
  parse(value: unknown): T;
};

export type ControlMethodDefinition<M extends RouteKitControlMethod> = {
  method: M;
  paramsSchema: ControlSchema<RouteKitControlParams[M]>;
  resultSchema: ControlSchema<RouteKitControlResults[M]>;
  authorization: ControlAuthorization;
  mutation: ControlMutationClassification;
  idempotency: ControlIdempotencyPolicy;
  handler: (
    params: RouteKitControlParams[M],
    context: ControlHandlerContext
  ) => RouteKitControlResults[M] | Promise<RouteKitControlResults[M]>;
};

export class ControlMethodRegistry {
  readonly #definitions = new Map<
    RouteKitControlMethod,
    ControlMethodDefinition<RouteKitControlMethod>
  >();

  register<M extends RouteKitControlMethod>(definition: ControlMethodDefinition<M>): void {
    if (this.#definitions.has(definition.method)) {
      throw new Error(`control method already registered: ${definition.method}`);
    }
    this.#definitions.set(
      definition.method,
      definition as unknown as ControlMethodDefinition<RouteKitControlMethod>
    );
  }

  definition(method: RouteKitControlMethod): ControlMethodDefinition<RouteKitControlMethod> {
    const definition = this.#definitions.get(method);
    if (definition === undefined) throw new Error(`control method is not registered: ${method}`);
    return definition;
  }

  handlers(): RouteKitControlHandlers {
    return Object.fromEntries(
      [...this.#definitions].map(([method, definition]) => [method, definition.handler])
    ) as RouteKitControlHandlers;
  }

  list(): readonly ControlMethodDefinition<RouteKitControlMethod>[] {
    return [...this.#definitions.values()];
  }
}
