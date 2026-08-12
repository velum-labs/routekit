# @velum-labs/routekit-runtime/control

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `42b1d41bcd6a6434a8d5c90f7f6b73f1f513a1fc5fd95bba5ce0a4913a5d6ea5`

## Root declarations

```ts
export type { ControlClientOptions, ControlTransport } from "./service/control-protocol.js";
export type { ControlErrorCode, ControlEvent, ControlFailure, ControlHandler, ControlHandlerContext, ControlPrincipal, ControlRequest, ControlResponse, ControlServerErrorContext, ControlSuccess, RunningControlServer } from "./service/control-protocol.js";
export { CONTROL_BODY_LIMIT_BYTES, CONTROL_PROTOCOL_VERSION, ControlError, controlTokenMatches, generateControlToken } from "./service/control-protocol.js";
export { ControlClient } from "./service/control-client.js";
export { HttpControlTransport } from "./service/control-client.js";
export { startControlServer } from "./service/control-server.js";
```
