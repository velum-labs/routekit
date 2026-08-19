# @velum-labs/routekit-daemon/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `379241665d647b55038788d707cf7f3f626912381dc8eef68261cb3261cb7f72`

## Root declarations

```ts
export type { ActiveGatewayValue } from "./services/active-gateway/service.js";
export type { DaemonAccountServices } from "./account-services.js";
export type { DaemonEnvValue, DaemonHosted } from "./daemon-env-context.js";
export type { DaemonGenerationHooks } from "./services/generations/service.js";
export type { DaemonHostValue } from "./daemon-host-context.js";
export type { DaemonLive, DaemonLiveOptions } from "./effect/daemon-live.js";
export type { DaemonPolicyValue } from "./daemon-policy-context.js";
export type { DaemonStateService } from "./daemon-state-context.js";
export type { DataPlaneValue } from "./data-plane-context.js";
export type { GatewayGenerationOptions, GatewayGenerationRedeemResetOptions, GatewayGenerationRedeemResetResponse, RunningGatewayGeneration } from "./gateway-generation.js";
export type { LeaderboardValue } from "./leaderboard-context.js";
export type { TelemetryServiceValue } from "./services/telemetry/service.js";
export { AccountRecovery } from "./account-recovery-context.js";
export { ActiveGateway } from "./services/active-gateway/service.js";
export { CallAttributions, type CallAttributionsValue } from "./services/call-attributions/service.js";
export { DaemonEnv } from "./daemon-env-context.js";
export { DaemonHost } from "./daemon-host-context.js";
export { DaemonPolicy } from "./daemon-policy-context.js";
export { DaemonState } from "./daemon-state-context.js";
export { DataPlane } from "./data-plane-context.js";
export { EvalSessions } from "./services/eval-session/service.js";
export { Generations } from "./services/generations/service.js";
export { Leaderboard } from "./leaderboard-context.js";
export { Sidecar } from "./sidecar-context.js";
export { Telemetry } from "./services/telemetry/service.js";
export { Tokens } from "./services/tokens/service.js";
export { daemonAccountServices } from "./account-services.js";
export { daemonLive } from "./effect/daemon-live.js";
export { runHostGenerationTransactionEffect } from "./host-generation-transaction.js";
export { startGatewayGenerationEffect } from "./gateway-generation.js";
```
