# @velum-labs/routekit-daemon/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `54bdb783a45fab9a66d1ab8a277a1e46f7c1827298d1bfbc0f020443afd05042`

## Root declarations

```ts
export type { ActiveGatewayValue, DaemonAccountServices, DaemonEnvValue, DaemonGenerationHooks, DaemonHosted, DaemonHostValue, DaemonPolicyValue, DaemonStateService, DataPlaneValue, LeaderboardValue, TelemetryServiceValue } from "./effect/services.js";
export type { DaemonLive, DaemonLiveOptions } from "./effect/daemon-live.js";
export { AccountRecovery, ActiveGateway, CallAttributions, DaemonEnv, DaemonHost, DaemonPolicy, DaemonState, DataPlane, Generations, Leaderboard, Sidecar, Telemetry, Tokens, daemonAccountServices } from "./effect/services.js";
export { daemonLive } from "./effect/daemon-live.js";
export { runHostGenerationTransactionEffect } from "./host-generation-transaction.js";
```
