# @velum-labs/routekit-daemon/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `ab74b0adb73183ebe34dbba205c251ceb4d6b6ca7fc273729f723f1a37825303`

## Root declarations

```ts
export type { ActiveGatewayValue, DaemonAccountServices, DaemonEnvValue, DaemonGenerationHooks, DaemonHosted, DaemonHostValue, DaemonPolicyValue, DaemonStateService, DataPlaneValue, LeaderboardValue, TelemetryServiceValue } from "./effect/services.js";
export type { DaemonLive, DaemonLiveOptions } from "./effect/daemon-live.js";
export { AccountRecovery, ActiveGateway, CallAttributions, DaemonEnv, DaemonHost, DaemonPolicy, DaemonState, DataPlane, daemonAccountServices, EvalSessions, Generations, Leaderboard, Sidecar, Telemetry, Tokens } from "./effect/services.js";
export { daemonLive } from "./effect/daemon-live.js";
export { runHostGenerationTransactionEffect } from "./host-generation-transaction.js";
```
