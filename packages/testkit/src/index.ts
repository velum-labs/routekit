/**
 * @velum-labs/routekit-testkit — RouteKit test tooling (never published).
 *
 * Provider simulator, door axis, SSE helpers, and process utilities used by the
 * RouteKit E2E matrix and package tests.
 */

export type {
  SimBehavior,
  SimBehaviorInput,
  SimDialect,
  SimError,
  SimJournalEntry,
  SimToolCall
} from "./behaviors.js";
export { asBehavior, simErrors } from "./behaviors.js";
export type { CliRunResult } from "./clis.js";
export {
  cliAvailable,
  cliSkip,
  runClaudeCode,
  runCodexExec,
  runOpenCode
} from "./clis.js";
export type { DoorProfile, DoorRequestInput, DoorToolCall, DoorToolExchange } from "./doors.js";
export { callDoor, DOOR_PROFILES, doorFrames } from "./doors.js";
export type { ReservedPort, SpawnedProcess } from "./proc.js";
export { freePort, reservePort, spawnCaptured, waitForHttpReady } from "./proc.js";
export type { ProviderSimHandle, SimCallFilter } from "./provider-sim.js";
export { startProviderSim } from "./provider-sim.js";
export type { SseFrame } from "./sse.js";
export { parseSse, sseDone, sseReasoning, sseText } from "./sse.js";
