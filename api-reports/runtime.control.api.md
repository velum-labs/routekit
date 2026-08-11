# @velum-labs/routekit-runtime/control

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `e1954a52af08260f360f3c9f9cb9fbc8d459082b885fc59ba283c7ebed3c9b04`

## Root declarations

```ts
export type { ControlClientOptions } from "./service/control-client.js";
export type { ControlErrorCode, ControlEvent, ControlFailure, ControlHandler, ControlHandlerContext, ControlPrincipal, ControlRequest, ControlResponse, ControlServerErrorContext, ControlSuccess, RunningControlServer } from "./service/control-protocol.js";
export { CONTROL_BODY_LIMIT_BYTES, CONTROL_PROTOCOL_VERSION, ControlError, controlTokenMatches, generateControlToken } from "./service/control-protocol.js";
export { ControlClient } from "./service/control-client.js";
export { startControlServer } from "./service/control-server.js";
```
