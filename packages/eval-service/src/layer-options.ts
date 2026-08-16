import type {
  NodeTestExecutionOptions,
  OriRouteKitModelAllowance
} from "@velum-labs/routekit-eval-engine";

import type { EvalServiceConfiguration } from "./service.js";

export type RouteKitEvalComparisonRunnerOptions = Omit<NodeTestExecutionOptions, "bridgeOrigin"> & {
  /**
   * Injected RouteKit data-plane credential.
   *
   * Discovery, validation, and estimation do not require it. Paid comparison
   * execution fails before starting a child when it is absent.
   */
  readonly bearerCredential?: string;
};

export type RouteKitEvalSetupLayerOptions = EvalServiceConfiguration &
  RouteKitEvalComparisonRunnerOptions & {
    readonly allowModel?: OriRouteKitModelAllowance;
    readonly authorHarness?: "pi" | "claude" | "codex";
    readonly authorModel?: string;
    readonly judgeModel?: string;
  };
