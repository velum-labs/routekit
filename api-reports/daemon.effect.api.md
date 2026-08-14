# @velum-labs/routekit-daemon/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `b0883b91587c6eff8a0deb62e7e48b46a5b229c765b0f3e66eedb59c0ef0aafa`

## Root declarations

```ts
export type { ActiveGatewayValue, DaemonEnvValue, DaemonGenerationHooks, DaemonHosted, TelemetryServiceValue } from "./effect/services.js";
export type { DaemonLive, DaemonLiveOptions } from "./effect/daemon-live.js";
export { ActiveGateway, DaemonEnv, DaemonState, Generations, Sidecar, Telemetry, Tokens, daemonAccountServices } from "./effect/services.js";
export { daemonLive } from "./effect/daemon-live.js";
export { runHostGenerationTransactionEffect } from "./host-generation-transaction.js";
```
