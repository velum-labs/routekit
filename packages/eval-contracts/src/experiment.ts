import { Schema } from "effect";

export const EXPERIMENT_MANIFEST_VERSION = 1 as const;

export const ExperimentManifestVersion = Schema.Literal(EXPERIMENT_MANIFEST_VERSION);
export type ExperimentManifestVersion = typeof ExperimentManifestVersion.Type;

export const ExperimentDataRole = Schema.Literals([
  "construction",
  "development",
  "validation",
  "confirmation",
  "locked_test"
]);
export type ExperimentDataRole = typeof ExperimentDataRole.Type;

export const ExperimentExecutor = Schema.Literals(["hosted-model", "sandbox", "local"]);
export type ExperimentExecutor = typeof ExperimentExecutor.Type;

export const ExperimentScalar = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null
]);
export type ExperimentScalar = typeof ExperimentScalar.Type;

export type ExperimentJsonValue =
  | ExperimentScalar
  | readonly ExperimentJsonValue[]
  | { readonly [key: string]: ExperimentJsonValue };

export const ExperimentJsonValue: Schema.Codec<ExperimentJsonValue> = Schema.suspend(
  (): Schema.Codec<ExperimentJsonValue> =>
    Schema.Union([
      ExperimentScalar,
      Schema.Array(ExperimentJsonValue),
      Schema.Record(Schema.String, ExperimentJsonValue)
    ])
);

export const ExperimentConfiguration = Schema.Record(Schema.String, ExperimentJsonValue);
export type ExperimentConfiguration = typeof ExperimentConfiguration.Type;

export const ExperimentCommand = Schema.Struct({
  executable: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutSeconds: Schema.optionalKey(Schema.Finite)
});
export type ExperimentCommand = typeof ExperimentCommand.Type;

export const ExperimentTreatment = Schema.Struct({
  id: Schema.String,
  executor: ExperimentExecutor,
  configuration: ExperimentConfiguration,
  image: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(ExperimentCommand),
  estimatedProviderCostUsd: Schema.optionalKey(Schema.Finite),
  estimatedInfrastructureCostUsd: Schema.optionalKey(Schema.Finite)
});
export type ExperimentTreatment = typeof ExperimentTreatment.Type;

export const ExperimentTask = Schema.Struct({
  id: Schema.String,
  inputArtifact: Schema.String,
  metadata: Schema.optionalKey(ExperimentConfiguration)
});
export type ExperimentTask = typeof ExperimentTask.Type;

export const ExperimentManifest = Schema.Struct({
  schemaVersion: ExperimentManifestVersion,
  experimentId: Schema.String,
  objective: Schema.String,
  code: Schema.Struct({
    image: Schema.String,
    sourceCommit: Schema.String
  }),
  dataset: Schema.Struct({
    id: Schema.String,
    hash: Schema.String,
    role: ExperimentDataRole
  }),
  matrix: Schema.Struct({
    treatments: Schema.Array(ExperimentTreatment),
    seeds: Schema.Array(Schema.Finite)
  }),
  tasks: Schema.Array(ExperimentTask),
  schedule: Schema.Struct({
    type: Schema.Literals(["paired_interleave", "exhaustive"]),
    maximumHostedCallsInFlight: Schema.Finite,
    maximumSandboxes: Schema.Finite
  }),
  selection: Schema.Struct({
    primaryMetric: Schema.String,
    secondaryMetrics: Schema.Array(Schema.String),
    maximumPromotedTreatments: Schema.Finite
  }),
  budget: Schema.Struct({
    providerMaximumUsd: Schema.Finite,
    vercelMaximumUsd: Schema.Finite
  }),
  dataAccess: Schema.Struct({
    lockedTest: Schema.Boolean
  })
});
export type ExperimentManifest = typeof ExperimentManifest.Type;

export const ClassificationPrediction = Schema.Struct({
  scopeProbabilities: Schema.Record(Schema.String, Schema.Finite),
  areaProbabilities: Schema.Record(Schema.String, Schema.Finite),
  rankedAreas: Schema.Array(Schema.String),
  latencyMs: Schema.Finite,
  providerCostUsd: Schema.Finite,
  infrastructureCostUsd: Schema.Finite,
  provenance: Schema.Struct({
    model: Schema.optionalKey(Schema.String),
    provider: Schema.optionalKey(Schema.String),
    imageDigest: Schema.String,
    datasetHash: Schema.String,
    configurationHash: Schema.String,
    seed: Schema.Finite
  })
});
export type ClassificationPrediction = typeof ClassificationPrediction.Type;

export const CompositionPrediction = Schema.Struct({
  areaCompositionScores: Schema.Record(Schema.String, Schema.Finite),
  unknownProbability: Schema.Finite,
  latencyMs: Schema.Finite,
  providerCostUsd: Schema.Finite,
  infrastructureCostUsd: Schema.Finite,
  provenance: Schema.Struct({
    model: Schema.optionalKey(Schema.String),
    provider: Schema.optionalKey(Schema.String),
    imageDigest: Schema.String,
    datasetHash: Schema.String,
    configurationHash: Schema.String,
    seed: Schema.Finite
  })
});
export type CompositionPrediction = typeof CompositionPrediction.Type;

export const ExperimentJob = Schema.Struct({
  id: Schema.String,
  experimentId: Schema.String,
  treatmentId: Schema.String,
  taskId: Schema.String,
  seed: Schema.Finite,
  executor: ExperimentExecutor,
  idempotencyKey: Schema.String,
  inputArtifact: Schema.String,
  configuration: ExperimentConfiguration,
  configurationHash: Schema.String,
  image: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(ExperimentCommand),
  estimatedProviderCostUsd: Schema.Finite,
  estimatedInfrastructureCostUsd: Schema.Finite
});
export type ExperimentJob = typeof ExperimentJob.Type;

export const FrozenExperimentPlan = Schema.Struct({
  manifest: ExperimentManifest,
  manifestHash: Schema.String,
  createdAt: Schema.String,
  jobs: Schema.Array(ExperimentJob)
});
export type FrozenExperimentPlan = typeof FrozenExperimentPlan.Type;

export const ExperimentStatus = Schema.Literals([
  "awaiting_approval",
  "queued",
  "running",
  "aggregating",
  "completed",
  "failed",
  "cancelled",
  "invalidated",
  "superseded"
]);
export type ExperimentStatus = typeof ExperimentStatus.Type;

export const ExperimentJobStatus = Schema.Literals([
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);
export type ExperimentJobStatus = typeof ExperimentJobStatus.Type;

export const ExperimentApprovalStage = Schema.Literals([
  "paid_execution",
  "confirmation",
  "locked_test"
]);
export type ExperimentApprovalStage = typeof ExperimentApprovalStage.Type;

export const ArtifactReference = Schema.Struct({
  digest: Schema.String,
  pathname: Schema.String,
  uri: Schema.String,
  contentType: Schema.String,
  size: Schema.Finite
});
export type ArtifactReference = typeof ArtifactReference.Type;

export const ExperimentRecord = Schema.Struct({
  experimentId: Schema.String,
  manifestHash: Schema.String,
  status: ExperimentStatus,
  manifest: ExperimentManifest,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  providerReservedUsd: Schema.Finite,
  providerSpentUsd: Schema.Finite,
  infrastructureReservedUsd: Schema.Finite,
  infrastructureSpentUsd: Schema.Finite,
  metricsArtifact: Schema.optionalKey(ArtifactReference),
  reportArtifact: Schema.optionalKey(ArtifactReference),
  error: Schema.optionalKey(Schema.String)
});
export type ExperimentRecord = typeof ExperimentRecord.Type;

export const ExperimentJobRecord = Schema.Struct({
  job: ExperimentJob,
  status: ExperimentJobStatus,
  retryable: Schema.Boolean,
  attemptCount: Schema.Finite,
  workerId: Schema.optionalKey(Schema.String),
  leaseExpiresAt: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
  finishedAt: Schema.optionalKey(Schema.String),
  outputArtifact: Schema.optionalKey(ArtifactReference),
  logArtifact: Schema.optionalKey(ArtifactReference),
  providerCostUsd: Schema.Finite,
  infrastructureCostUsd: Schema.Finite,
  latencyMs: Schema.optionalKey(Schema.Finite),
  error: Schema.optionalKey(Schema.String)
});
export type ExperimentJobRecord = typeof ExperimentJobRecord.Type;

export const ExperimentApproval = Schema.Struct({
  experimentId: Schema.String,
  stage: ExperimentApprovalStage,
  actor: Schema.String,
  approvedAt: Schema.String
});
export type ExperimentApproval = typeof ExperimentApproval.Type;

export const ExperimentSnapshot = Schema.Struct({
  experiment: ExperimentRecord,
  jobs: Schema.Array(ExperimentJobRecord),
  approvals: Schema.Array(ExperimentApproval)
});
export type ExperimentSnapshot = typeof ExperimentSnapshot.Type;

export const ExperimentQueueMessage = Schema.Struct({
  experimentId: Schema.String,
  jobId: Schema.String
});
export type ExperimentQueueMessage = typeof ExperimentQueueMessage.Type;
