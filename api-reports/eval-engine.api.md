# @velum-labs/routekit-eval-engine

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `a80a6cdb9b3224beaa8f4af949c97151da81283ba24c29c1e728bd8c35281e2c`

## Root declarations

```ts
export declare const routeKitEvalStandaloneBaseline: "complete";
export type { EvalEngineDiscovery, EvalEngineService, EvalEngineValidation, EvalExecutionOutput, EvalExecutionPortService } from "./library/eval-engine.js";
export type { NodeTestExecutionOptions } from "./library/node-test-execution.js";
export type { RouteKitEvalExecutionOptions } from "./library/routekit-execution.js";
export type { RouteKitEvalGatewayBridgeOptions, RouteKitEvalGatewayBridgeService } from "./library/gateway-bridge.js";
export { EvalEngineDryLoadError } from "./library/dry-load.js";
export { discoverEvals, EvalEngine, EvalEngineDiscoveryError, EvalEngineExecutionError, EvalEngineInvalidRequestError, EvalEnginePortableImportError, EvalExecutionPort, makeEvalEngineLayer, runEvalComparison, validateEvals } from "./library/eval-engine.js";
export { makeNodeTestExecutionPort } from "./library/node-test-execution.js";
export { makeRouteKitEvalEngineLayer, makeRouteKitEvalExecutionPort } from "./library/routekit-execution.js";
export { makeRouteKitEvalGatewayBridge, makeRouteKitEvalGatewayBridgeLayer, RouteKitEvalGatewayBridge, RouteKitEvalGatewayBridgeConfigurationError, RouteKitEvalGatewayBridgeStartError } from "./library/gateway-bridge.js";
```
