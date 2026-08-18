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
};
