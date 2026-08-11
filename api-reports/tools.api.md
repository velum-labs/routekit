# @velum-labs/routekit-tools

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `29855ddbabce62d042c8335432cbf0fecae30161a67980085683603f8ec272a7`

## Root declarations

```ts
export type { AgentProfile, ToolCapabilityGrade, ToolCapabilityMetadata, ToolDriverMetadata, ToolDriverRoute, ToolIntegration, ToolLaunchContext, ToolLaunchSpec, ToolModel, ToolModelFeature, ToolModelFeatureStatus } from "./types.js";
export type { CreateToolLaunchContextInput, DisposerRunner, ToolDisposer, ToolLaunchContextHandle } from "./launch-context.js";
export type { ToolCapabilityCell, ToolRegistry } from "./registry.js";
export { createDisposerRunner, createToolLaunchContext } from "./launch-context.js";
export { createToolCapabilityMatrix, createToolRegistry } from "./registry.js";
```
