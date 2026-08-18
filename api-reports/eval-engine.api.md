# @velum-labs/routekit-eval-engine

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `89ce743e28d8934019b2e78c4257ee9f47b20bd89fffbbf5f2f196c7cbd0faf8`

## Root declarations

```ts
export declare const routeKitEvalStandaloneBaseline: "complete";
export type { EvalComparisonEvidence, EvalEngineDiscovery, EvalEngineService, EvalEngineValidation, EvalExecutionModels, EvalExecutionOutput, EvalExecutionPortService } from "./library/eval-engine.js";
export type { NodeTestExecutionOptions } from "./library/node-test-execution.js";
export type { OriRouteKitGatewayAttribution, OriRouteKitGatewayBridgeOptions, OriRouteKitGatewayBridgeService, OriRouteKitModelAllowance } from "./library/ori-gateway-bridge.js";
export type { RouteKitEvalExecutionOptions } from "./library/routekit-execution.js";
export type { RouteKitEvalGatewayBridgeOptions, RouteKitEvalGatewayBridgeService } from "./library/gateway-bridge.js";
export { EvalEngineDryLoadError } from "./library/dry-load.js";
export { discoverEvals, EvalEngine, EvalEngineDiscoveryError, EvalEngineExecutionError, EvalEngineInvalidRequestError, EvalEnginePortableImportError, EvalExecutionPort, evalExecutionModels, makeEvalEngine, makeEvalEngineLayer, normalizeEvalComparisonEvidence, runEvalComparison, validateEvals } from "./library/eval-engine.js";
export { makeNodeTestExecutionPort } from "./library/node-test-execution.js";
export { makeOriRouteKitGatewayBridge, makeOriRouteKitGatewayBridgeLayer, OriRouteKitGatewayBridge, OriRouteKitGatewayBridgeConfigurationError, OriRouteKitGatewayBridgeStartError } from "./library/ori-gateway-bridge.js";
export { makeRouteKitEvalEngineLayer, makeRouteKitEvalExecutionPort, makeRouteKitEvalExecutionPortService } from "./library/routekit-execution.js";
export { makeRouteKitEvalGatewayBridge, makeRouteKitEvalGatewayBridgeLayer, RouteKitEvalGatewayBridge, RouteKitEvalGatewayBridgeConfigurationError, RouteKitEvalGatewayBridgeStartError } from "./library/gateway-bridge.js";
```
