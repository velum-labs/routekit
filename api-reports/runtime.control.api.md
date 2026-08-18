# @velum-labs/routekit-runtime/control

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `0c437b9948fde1445f4b65009a5ce680f59a8274e0542049ea34770afe53fcdf`

## Root declarations

```ts
export type { ControlClientOptions, ControlTransport } from "./control/protocol.js";
export type { ControlErrorCode, ControlEvent, ControlFailure, ControlHandler, ControlHandlerContext, ControlPrincipal, ControlRequest, ControlResponse, ControlServerErrorContext, ControlSuccess, RunningControlServer } from "./control/protocol.js";
export { CONTROL_BODY_LIMIT_BYTES, CONTROL_PROTOCOL_VERSION, ControlError, controlTokenMatches, generateControlToken } from "./control/protocol.js";
export { ControlClient } from "./services/control-client/service.js";
export { HttpControlTransport } from "./services/control-client/service.js";
export { startControlServer } from "./services/control-server/service.js";
```
