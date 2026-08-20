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
};
