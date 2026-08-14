import { Data, Effect, Schema } from "effect";

/** Header that marks an eval egress call so the auto-router must not apply. */
export const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";

/** Attribution metadata for candidate and judge calls. */
export const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";

export const EVAL_CONTRACT_VERSION = 2 as const;

export const EvalContractVersion = Schema.Literal(EVAL_CONTRACT_VERSION);
export type EvalContractVersion = typeof EvalContractVersion.Type;

/** Evaluation must never select the online auto-router. */
export const EVAL_FORBIDDEN_MODELS = ["auto", "router", "default"] as const;

export const EvalRole = Schema.Literals(["candidate", "judge"]);
export type EvalRole = typeof EvalRole.Type;

export const EvalOutcome = Schema.Literals(["failed", "passed", "unknown"]);
export type EvalOutcome = typeof EvalOutcome.Type;

export const EvalAttribution = Schema.Struct({
  purpose: Schema.Literal("eval"),
  role: EvalRole,
  runId: Schema.String,
  caseId: Schema.String
});
export type EvalAttribution = typeof EvalAttribution.Type;

export const EvalUsage = Schema.Struct({
  inputTokens: Schema.optionalKey(Schema.Finite),
  outputTokens: Schema.optionalKey(Schema.Finite),
  contextTokens: Schema.optionalKey(Schema.Finite),
  costUsd: Schema.optionalKey(Schema.Finite)
});
export type EvalUsage = typeof EvalUsage.Type;

export const EvalEvaluatorMetadata = Schema.Struct({
  kind: Schema.Literals(["assertion", "engine", "llm-judge"]),
  name: Schema.String,
  version: Schema.optionalKey(Schema.String),
  criteria: Schema.optionalKey(Schema.String),
  minScore: Schema.optionalKey(Schema.Finite)
});
export type EvalEvaluatorMetadata = typeof EvalEvaluatorMetadata.Type;

/** Reproducibility metadata attached to every completed engine run. */
export const EvalRunManifest = Schema.Struct({
  version: EvalContractVersion,
  runId: Schema.String,
  suiteId: Schema.String,
  suiteDigest: Schema.String,
  workloadId: Schema.String,
  candidateModel: Schema.String,
  judgeModel: Schema.String,
  engineVersion: Schema.String,
  inventoryFingerprint: Schema.optionalKey(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  evaluator: EvalEvaluatorMetadata
});
export type EvalRunManifest = typeof EvalRunManifest.Type;

export const NormalizedEvalObservation = Schema.Struct({
  version: EvalContractVersion,
  runId: Schema.String,
  caseId: Schema.optionalKey(Schema.String),
  suiteId: Schema.String,
  suiteDigest: Schema.String,
  workloadId: Schema.String,
  candidateModel: Schema.String,
  judgeModel: Schema.String,
  engineVersion: Schema.String,
  inventoryFingerprint: Schema.optionalKey(Schema.String),
  role: EvalRole,
  model: Schema.String,
  outcome: EvalOutcome,
  score: Schema.optionalKey(Schema.Finite),
  cutOff: Schema.Boolean,
  durationMs: Schema.optionalKey(Schema.Finite),
  usage: Schema.optionalKey(EvalUsage),
  evaluator: EvalEvaluatorMetadata,
  outcomeDetail: Schema.optionalKey(Schema.String)
});
export type NormalizedEvalObservation = typeof NormalizedEvalObservation.Type;

export const EvalEngineHost = Schema.Struct({
  architecture: Schema.optionalKey(Schema.String),
  hostname: Schema.optionalKey(Schema.String),
  nodeVersion: Schema.optionalKey(Schema.String),
  operatingSystem: Schema.optionalKey(Schema.String),
  runner: Schema.optionalKey(Schema.String)
});

export const EvalEngineTerminal = Schema.Struct({
  createdAt: Schema.optionalKey(Schema.String),
  harness: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  payload: Schema.optionalKey(Schema.Unknown),
  runId: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
  type: Schema.String
});

export const EvalEngineResult = Schema.Struct({
  model: Schema.String,
  runKey: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(EvalRole),
  suiteId: Schema.optionalKey(Schema.String),
  caseId: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(EvalEngineHost),
  durationMs: Schema.optionalKey(Schema.Finite),
  eventCounts: Schema.optionalKey(Schema.Unknown),
  outputChars: Schema.optionalKey(Schema.Finite),
  terminal: Schema.optionalKey(EvalEngineTerminal),
  toolCalls: Schema.optionalKey(Schema.Array(Schema.String)),
  usage: Schema.optionalKey(EvalUsage),
  cutOff: Schema.Boolean,
  outcome: EvalOutcome,
  outcomeDetail: Schema.optionalKey(Schema.String),
  score: Schema.optionalKey(Schema.Finite)
});

export const EvalEngineTest = Schema.Struct({
  durationMs: Schema.optionalKey(Schema.Finite),
  file: Schema.optionalKey(Schema.String),
  name: Schema.String,
  status: Schema.Literals(["pass", "fail", "skipped"])
});

export const EvalEngineRun = Schema.Struct({
  searchRoot: Schema.String,
  workingDirectory: Schema.String,
  files: Schema.Array(Schema.String),
  exitCode: Schema.Finite,
  results: Schema.Array(EvalEngineResult),
  tests: Schema.Array(EvalEngineTest),
  durationMs: Schema.Finite,
  stdout: Schema.String,
  stderr: Schema.String
});
export type EvalEngineRun = typeof EvalEngineRun.Type;

/** Immutable raw engine document written before any policy compilation. */
export const StoredEvalRun = Schema.Struct({
  version: EvalContractVersion,
  manifest: EvalRunManifest,
  engine: EvalEngineRun
});
export type StoredEvalRun = typeof StoredEvalRun.Type;

export const StoredEvalObservations = Schema.Struct({
  version: EvalContractVersion,
  runId: Schema.String,
  observations: Schema.Array(NormalizedEvalObservation)
});
export type StoredEvalObservations = typeof StoredEvalObservations.Type;

export const EvalPolicy = Schema.Struct({
  version: EvalContractVersion,
  dedicatedToken: Schema.Literal(true),
  explicitModelIds: Schema.Literal(true),
  policyBypass: Schema.Literal(true),
  autoRouterForbidden: Schema.Literal(true),
  onlineRequestPathIsolated: Schema.Literal(true)
});
export type EvalPolicy = typeof EvalPolicy.Type;

export const EVAL_POLICY: EvalPolicy = {
  version: EVAL_CONTRACT_VERSION,
  dedicatedToken: true,
  explicitModelIds: true,
  policyBypass: true,
  autoRouterForbidden: true,
  onlineRequestPathIsolated: true
};

export function isForbiddenEvalModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    EVAL_FORBIDDEN_MODELS.includes(normalized as (typeof EVAL_FORBIDDEN_MODELS)[number]) ||
    !model.includes("/")
  );
}

export class InvalidEvalModelError extends Data.TaggedError("InvalidEvalModelError")<{
  readonly model: string;
  readonly role: EvalRole;
}> {
  override get message(): string {
    return `${this.role} model must be an explicit provider/model id, not ${JSON.stringify(this.model)}`;
  }
}

export function validateExplicitEvalModel(
  model: string,
  role: EvalRole
): Effect.Effect<string, InvalidEvalModelError> {
  if (isForbiddenEvalModel(model)) {
    return Effect.fail(new InvalidEvalModelError({ model, role }));
  }
  return Effect.succeed(model);
}
