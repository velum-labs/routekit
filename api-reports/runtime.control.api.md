# @velum-labs/routekit-runtime/control

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `66425d935a457b2d8ee94e42204cb1f0cce7f71a9be5bbeeeee3d3c2b5fefe2f`

## Root declarations

```ts
export type { ControlClientOptions, ControlTransport } from "./control/protocol.js";
export type { ControlErrorCode, ControlEvent, ControlFailure, ControlHandler, ControlHandlerContext, ControlPrincipal, ControlRequest, ControlResponse, ControlServerErrorContext, ControlSuccess, RunningControlServer } from "./control/protocol.js";
export { CONTROL_BODY_LIMIT_BYTES, CONTROL_PROTOCOL_VERSION, ControlError, controlTokenMatches, generateControlToken } from "./control/protocol.js";
export { ControlClient } from "./control-client-service.js";
export { HttpControlTransport } from "./control-client-service.js";
export { startControlServer } from "./control-server-service.js";
```
