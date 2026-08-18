# @velum-labs/routekit-daemon/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `000a78f5d25e88ee6f81b43475a52a67b4559a95e0e1cd14e254c708adca1158`

## Root declarations

```ts
export type { ActiveGatewayValue, DaemonAccountServices, DaemonEnvValue, DaemonGenerationHooks, DaemonHosted, DaemonHostValue, DaemonPolicyValue, DaemonStateService, DataPlaneValue, LeaderboardValue, TelemetryServiceValue } from "./effect/services.js";
export type { DaemonLive, DaemonLiveOptions } from "./effect/daemon-live.js";
export type { GatewayGenerationOptions, GatewayGenerationRedeemResetOptions, GatewayGenerationRedeemResetResponse, RunningGatewayGeneration } from "./services/gateway-generation/service.js";
export { AccountRecovery, ActiveGateway, CallAttributions, DaemonEnv, DaemonHost, DaemonPolicy, DaemonState, DataPlane, daemonAccountServices, EvalSessions, Generations, Leaderboard, Sidecar, Telemetry, Tokens } from "./effect/services.js";
export { daemonLive } from "./effect/daemon-live.js";
export { runHostGenerationTransactionEffect } from "./host-generation-transaction.js";
export { startGatewayGenerationEffect } from "./services/gateway-generation/service.js";
```
