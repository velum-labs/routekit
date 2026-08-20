import type {
  NodeTestExecutionOptions
} from "@velum-labs/routekit-eval-engine";

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
   * Run the node:test child from a temporary copy of the reviewed suite.
   *
   * Qualification enables this so a project-local `routekit/eval` or `ori/eval`
   * package cannot shadow the bundled bridge-aware SDK used by the production
   * execution adapter.
   */
  readonly isolateExecutionFromProjectSdk?: boolean;
};
