import type {
  NodeTestExecutionOptions
} from "@velum-labs/routekit-eval-engine";
import type { Effect } from "effect";

export type RouteKitEvalGatewayCallEvent =
  | {
      readonly observationId: string;
      readonly phase: "issued";
      readonly role: "candidate" | "judge";
    }
  | {
      readonly callId?: string;
      readonly observationId: string;
      readonly phase: "completed";
      readonly role: "candidate" | "judge";
    };

export type RouteKitEvalServiceOptions = Omit<NodeTestExecutionOptions, "bridgeOrigin"> & {
  /**
   * Injected RouteKit data-plane credential.
   *
   * Discovery, validation, and estimation do not require it. Paid comparison
   * execution fails before starting a child when it is absent.
   */
  readonly bearerCredential?: string;
  /**
   * Host-owned per-test deadline.
   *
   * When set, the production execution adapter applies this value at the
   * node:test boundary even if an intermediate comparison request carries a
   * stale or missing timeout.
   */
  readonly timeoutMs?: number;
  /**
   * Observe the exact parent-owned HTTP client used by the child gateway
   * bridge. The callback runs when an attributed request is issued and again
   * when a model call id is available from its response.
   */
  readonly observeGatewayCall?: (event: RouteKitEvalGatewayCallEvent) => Effect.Effect<void>;
  /**
   * Run the node:test child from a temporary copy of the reviewed suite.
   *
   * Qualification enables this so a project-local `routekit/eval` or `ori/eval`
   * package cannot shadow the bundled bridge-aware SDK used by the production
   * execution adapter.
   */
  readonly isolateExecutionFromProjectSdk?: boolean;
};
