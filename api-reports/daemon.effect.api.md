# @velum-labs/routekit-daemon/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `f7a2390e57f8d7f8c06130ecdcade42f230d53b3dafb6601e0d326a7860070a1`

## Root declarations

```ts
export type { ActiveGatewayValue, DaemonEnvValue, DaemonGenerationHooks, DaemonHosted, DaemonHostValue, DaemonPolicyValue, DataPlaneValue, LeaderboardValue, TelemetryServiceValue } from "./effect/services.js";
export type { DaemonLive, DaemonLiveOptions } from "./effect/daemon-live.js";
export { AccountRecovery, ActiveGateway, CallAttributions, DaemonEnv, DaemonHost, DaemonPolicy, DaemonState, DataPlane, Generations, Leaderboard, Sidecar, Telemetry, Tokens, daemonAccountServices } from "./effect/services.js";
export { daemonLive } from "./effect/daemon-live.js";
export { runHostGenerationTransactionEffect } from "./host-generation-transaction.js";
```
