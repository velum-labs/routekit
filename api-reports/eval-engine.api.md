# @velum-labs/routekit-eval-engine

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `15145865534bb2412f811a8476e2ce3518a7b6a04337af421d0d3c9f2690f5a2`

## Root declarations

```ts
export declare const routeKitEvalStandaloneBaseline: "complete";
export type { EvalComparisonEvidence, EvalEngineDiscovery, EvalEngineService, EvalEngineValidation, EvalExecutionModels, EvalExecutionOutput, EvalExecutionPortService } from "./library/eval-engine.js";
export type { NodeTestExecutionOptions } from "./library/node-test-execution.js";
export type { OriRouteKitGatewayAttribution, OriRouteKitGatewayBridgeOptions, OriRouteKitGatewayBridgeService, OriRouteKitModelAllowance } from "./library/ori-gateway-bridge.js";
export type { RouteKitEvalExecutionOptions } from "./library/routekit-execution.js";
export type { RouteKitEvalGatewayBridgeOptions, RouteKitEvalGatewayBridgeService } from "./library/gateway-bridge.js";
export { EvalEngineDryLoadError } from "./library/dry-load.js";
export { discoverEvals, EvalEngine, EvalEngineDiscoveryError, EvalEngineExecutionError, EvalEngineInvalidRequestError, EvalEnginePortableImportError, EvalExecutionPort, evalExecutionModels, makeEvalEngineLayer, normalizeEvalComparisonEvidence, runEvalComparison, validateEvals } from "./library/eval-engine.js";
export { makeNodeTestExecutionPort } from "./library/node-test-execution.js";
export { makeOriRouteKitGatewayBridge, makeOriRouteKitGatewayBridgeLayer, OriRouteKitGatewayBridge, OriRouteKitGatewayBridgeConfigurationError, OriRouteKitGatewayBridgeStartError } from "./library/ori-gateway-bridge.js";
export { makeRouteKitEvalEngineLayer, makeRouteKitEvalExecutionPort } from "./library/routekit-execution.js";
export { makeRouteKitEvalGatewayBridge, makeRouteKitEvalGatewayBridgeLayer, RouteKitEvalGatewayBridge, RouteKitEvalGatewayBridgeConfigurationError, RouteKitEvalGatewayBridgeStartError } from "./library/gateway-bridge.js";
```
