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
export {
  DEFAULT_TESTDRIVE_FAILSAFES,
  TESTDRIVE_SCHEMA_VERSION,
  TestdriveClassifierQualification,
  TestdriveEvent,
  TestdriveFailsafes,
  TestdriveLedgerSnapshot,
  TestdriveReport,
  TestdriveDimensionReport
} from "./eval-routing-testdrive/contracts.js";
export {
  evalRoutingTestdriveCommand,
  runEvalRoutingTestdriveMain
} from "./eval-routing-testdrive/main.js";
export type { LiveEvalRoutingTestdriveOptions } from "./eval-routing-testdrive/runner.js";
export { runLiveEvalRoutingTestdrive } from "./eval-routing-testdrive/runner.js";
export type {
  CompositionBenchmark,
  CompositionBenchmarkCase,
  CompositionModelResult,
  CompositionQualificationCaseReport,
  CompositionQualificationFailureCode,
  CompositionQualificationObservation,
  CompositionQualificationReport,
  CompositionQualificationThresholds
} from "./eval-routing-compositional/composition-qualification.js";
export {
  CompositionQualificationConfigurationError,
  COMPOSITION_QUALIFICATION_SCHEMA_VERSION,
  qualifyCompositionPredictions
} from "./eval-routing-compositional/composition-qualification.js";
export type {
  ClassifierBenchmark,
  ClassifierBenchmarkCase,
  ClassifierBenchmarkCaseKind,
  ClassifierBenchmarkTarget,
  ClassifierQualificationCaseReport,
  ClassifierQualificationFailureCode,
  ClassifierQualificationObservation,
  ClassifierQualificationReport,
  ClassifierQualificationThresholds,
  RoutingBasisFixture
} from "./eval-routing-compositional/qualification.js";
export {
  CLASSIFIER_QUALIFICATION_SCHEMA_VERSION,
  ClassifierQualificationConfigurationError,
  qualifyDimensionClassifier,
  routingBasisFromFixture,
  runDimensionClassifierQualification
} from "./eval-routing-compositional/qualification.js";
export type { ReservedPort, SpawnedProcess } from "./proc.js";
export { freePort, reservePort, spawnCaptured, waitForHttpReady } from "./proc.js";
export type { ProviderSimHandle, SimCallFilter } from "./provider-sim.js";
export { startProviderSim } from "./provider-sim.js";
export type { SseFrame } from "./sse.js";
export { parseSse, sseDone, sseReasoning, sseText } from "./sse.js";
