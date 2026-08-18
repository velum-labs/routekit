export { EvalEngineDryLoadError } from "./library/dry-load.ts";
export type {
  EvalComparisonEvidence,
  EvalEngineDiscovery,
  EvalEngineService,
  EvalEngineValidation,
  EvalExecutionModels,
  EvalExecutionOutput,
  EvalExecutionPortService
} from "./library/eval-engine.ts";
export {
  discoverEvals,
  EvalEngine,
  EvalEngineDiscoveryError,
  EvalEngineExecutionError,
  EvalEngineInvalidRequestError,
  EvalEnginePortableImportError,
  EvalExecutionPort,
  evalExecutionModels,
  makeEvalEngine,
  makeEvalEngineLayer,
  normalizeEvalComparisonEvidence,
  runEvalComparison,
  validateEvals
} from "./library/eval-engine.ts";
export type {
  RouteKitEvalGatewayBridgeOptions,
  RouteKitEvalGatewayBridgeService
} from "./library/gateway-bridge.ts";
export {
  makeRouteKitEvalGatewayBridge,
  makeRouteKitEvalGatewayBridgeLayer,
  RouteKitEvalGatewayBridge,
  RouteKitEvalGatewayBridgeConfigurationError,
  RouteKitEvalGatewayBridgeStartError
} from "./library/gateway-bridge.ts";
export type { NodeTestExecutionOptions } from "./library/node-test-execution.ts";
export { makeNodeTestExecutionPort } from "./library/node-test-execution.ts";
export type {
  OriRouteKitGatewayAttribution,
  OriRouteKitGatewayBridgeOptions,
  OriRouteKitGatewayBridgeService,
  OriRouteKitModelAllowance
} from "./library/ori-gateway-bridge.ts";
export {
  makeOriRouteKitGatewayBridge,
  makeOriRouteKitGatewayBridgeLayer,
  OriRouteKitGatewayBridge,
  OriRouteKitGatewayBridgeConfigurationError,
  OriRouteKitGatewayBridgeStartError
} from "./library/ori-gateway-bridge.ts";
export type { RouteKitEvalExecutionOptions } from "./library/routekit-execution.ts";
export {
  makeRouteKitEvalEngineLayer,
  makeRouteKitEvalExecutionPort,
  makeRouteKitEvalExecutionPortService
} from "./library/routekit-execution.ts";

export const routeKitEvalStandaloneBaseline = "complete" as const;
