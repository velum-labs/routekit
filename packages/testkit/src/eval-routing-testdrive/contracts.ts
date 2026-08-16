import { Data, Schema } from "effect";

export const TESTDRIVE_SCHEMA_VERSION = 1 as const;

export const DEFAULT_TESTDRIVE_FAILSAFES = {
  maxEgressCalls: 512,
  maxInputTokens: 5_000_000,
  maxOutputTokens: 1_000_000,
  maxEstimatedCostUsd: 100,
  maxWallTimeMs: 2 * 60 * 60 * 1_000,
  maxOutputTokensPerCall: 16_384
} as const;

const NonNegative = Schema.Finite.pipe(
  Schema.check(
    Schema.makeFilter((value: number) =>
      value >= 0 ? undefined : "value must be greater than or equal to zero"
    )
  )
);

export const TestdriveFailsafes = Schema.Struct({
  maxEgressCalls: Schema.Int,
  maxInputTokens: Schema.Int,
  maxOutputTokens: Schema.Int,
  maxEstimatedCostUsd: NonNegative,
  maxWallTimeMs: Schema.Int,
  maxOutputTokensPerCall: Schema.Int
});
export type TestdriveFailsafes = typeof TestdriveFailsafes.Type;

export const TestdriveLedgerSnapshot = Schema.Struct({
  calls: Schema.Int,
  activeReservations: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  estimatedCostUsd: NonNegative,
  unknownMeasurements: Schema.Int,
  unpricedCalls: Schema.Int
});
export type TestdriveLedgerSnapshot = typeof TestdriveLedgerSnapshot.Type;

export const TestdriveEventType = Schema.Literals([
  "run-started",
  "run-finished",
  "phase-started",
  "phase-finished",
  "process-finished",
  "egress-reserved",
  "egress-reconciled",
  "profile-transition",
  "comparison-finished",
  "snapshot-published",
  "routing-decision",
  "cleanup-finished",
  "failure"
]);
export type TestdriveEventType = typeof TestdriveEventType.Type;

export const TestdriveEvent = Schema.Struct({
  version: Schema.Literal(TESTDRIVE_SCHEMA_VERSION),
  sequence: Schema.Int,
  timestamp: Schema.String,
  runId: Schema.String,
  type: TestdriveEventType,
  phase: Schema.optionalKey(Schema.String),
  profileId: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  callId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  failureCode: Schema.optionalKey(Schema.String),
  durationMs: Schema.optionalKey(NonNegative),
  inputTokens: Schema.optionalKey(Schema.Int),
  outputTokens: Schema.optionalKey(Schema.Int),
  estimatedCostUsd: Schema.optionalKey(NonNegative)
});
export type TestdriveEvent = typeof TestdriveEvent.Type;

export const TestdriveProfileReport = Schema.Struct({
  profileId: Schema.String,
  description: Schema.String,
  selectedModel: Schema.String,
  fallbackModels: Schema.Array(Schema.String),
  suiteDigest: Schema.String,
  evidenceDigest: Schema.String
});
export type TestdriveProfileReport = typeof TestdriveProfileReport.Type;

export const TestdriveRoutingDecision = Schema.Struct({
  promptKind: Schema.String,
  profileId: Schema.String,
  selectedModel: Schema.String,
  evidenceDigest: Schema.String,
  scores: Schema.Array(
    Schema.Struct({
      profileId: Schema.String,
      probability: NonNegative
    })
  ),
  classifierCallId: Schema.String,
  inferenceCallId: Schema.String
});
export type TestdriveRoutingDecision = typeof TestdriveRoutingDecision.Type;

export const TestdriveReport = Schema.Struct({
  version: Schema.Literal(TESTDRIVE_SCHEMA_VERSION),
  runId: Schema.String,
  revision: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  status: Schema.Literals(["passed", "failed"]),
  failsafes: TestdriveFailsafes,
  ledger: TestdriveLedgerSnapshot,
  models: Schema.Array(Schema.String),
  profiles: Schema.Array(TestdriveProfileReport),
  routingDecisions: Schema.Array(TestdriveRoutingDecision),
  eventCount: Schema.Int
});
export type TestdriveReport = typeof TestdriveReport.Type;

export class TestdriveConfigurationError extends Data.TaggedError("TestdriveConfigurationError")<{
  readonly detail: string;
}> {}

export class TestdriveProcessError extends Data.TaggedError("TestdriveProcessError")<{
  readonly command: string;
  readonly detail: string;
  readonly exitCode?: number;
}> {}

export class TestdriveGuardError extends Data.TaggedError("TestdriveGuardError")<{
  readonly code:
    | "call-limit"
    | "cost-limit"
    | "input-token-limit"
    | "measurement-missing"
    | "output-token-limit";
  readonly detail: string;
}> {}

export class TestdriveEvidenceError extends Data.TaggedError("TestdriveEvidenceError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export class TestdriveWorkflowError extends Data.TaggedError("TestdriveWorkflowError")<{
  readonly phase: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}
