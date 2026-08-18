export const SCHEMA_VERSION = 1 as const;
export const TASK_EPISODE_SCHEMA_VERSION = 2 as const;

export type Split = "reference" | "validation" | "test";
export type UnknownType = "new_repository_area" | "outside_scope" | "insufficient_information";
export type Confidence = "low" | "medium" | "high";

export interface ConversationTurn {
  role: "user" | "assistant" | "diagnostic";
  text: string;
  timestamp?: string;
}

export interface TaskEpisodeV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  repositoryId: string;
  repositorySnapshot: string;
  sessionHash: string;
  lineageHash: string;
  timestamp: string;
  split: Split;
  currentRequest: string;
  taskAnchor?: string;
  precedingAssistant?: string;
  earlierUserContext?: string[];
  relevantDiagnostic?: string;
  source: "codex" | "github" | "derived";
  actualChangedPaths?: string[];
}

export interface TaskEpisodeV2 {
  schemaVersion: typeof TASK_EPISODE_SCHEMA_VERSION;
  id: string;
  repositoryId: string;
  repositorySnapshot: string;
  sessionHash: string;
  lineageHash: string;
  timestamp: string;
  split: Split;
  currentRequest: string;
  taskAnchor?: string;
  precedingAssistant?: string;
  earlierUserContext?: string[];
  relevantDiagnostic?: string;
  source: "codex";
  actualChangedPaths?: string[];
  provenance: {
    collectorVersion: "codex-v2";
    userIdHash: string;
    sessionIdHash: string;
    turnId: string;
    sessionRelativePath: string;
    sessionSource?: string;
    originatorId?: string;
    repositoryUrl?: string;
    repositoryMatch: "url" | "cwd";
    snapshotSource: "session_meta" | "provided_fallback";
    turnStatus: "complete" | "aborted" | "incomplete";
    recordStart: number;
    recordEnd: number;
    redactionCount: number;
    context: {
      hasTaskAnchor: boolean;
      hasPrecedingAssistant: boolean;
      hasEarlierUserContext: boolean;
      hasRelevantDiagnostic: boolean;
      isReferentialRequest: boolean;
    };
  };
}

export type TaskEpisode = TaskEpisodeV1 | TaskEpisodeV2;

export interface RepositoryProfileV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  repositoryId: string;
  snapshot: string;
  name: string;
  purpose: string;
  languages: string[];
  frameworks: string[];
  components: Array<{ name: string; purpose: string; paths: string[] }>;
  generatorVersion: string;
}

export interface AreaCardV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  registryVersion: string;
  repositoryId: string;
  areaId: string;
  name: string;
  description: string;
  inclusions: string[];
  exclusions: string[];
  confusableAreaIds: string[];
  pathAnchors: string[];
  componentAnchors: string[];
  symbolAnchors: string[];
  codeSummaries: string[];
  codeSnippets: string[];
  positiveExampleIds: string[];
  boundaryExamples: string[];
  sourceHashes: string[];
  generatorVersion: string;
}

export interface SilverLabelV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  taskEpisodeId: string;
  selectedAreaIds: string[];
  known: boolean;
  unknownType?: UnknownType;
  difficulty: "clear" | "contextual" | "boundary_multi_area" | "unknown" | "insufficient_information";
  confidence: Confidence;
  reason: string;
  relevantPaths: string[];
  oracle: {
    model: string;
    reasoningEffort: string;
    passCount: number;
    adjudicated: boolean;
    humanReviewed: false;
    toolCalls?: number;
    repositoryInspected?: boolean;
  };
}

export interface AreaScore {
  areaId: string;
  score: number;
  evidenceIds: string[];
}

export interface ClassifierPredictionV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  taskEpisodeId: string;
  classifier: string;
  areaScores: AreaScore[];
  selectedAreaIds: string[];
  known: boolean;
  unknownType?: UnknownType;
  confidence: number;
  /**
   * Optional decomposed confidence components for accuracy-first classifiers.
   * `gateConfidence` covers actionable/in-scope/registry-fit gating.
   * `areaConfidence` is null for unknown decisions and a probability for
   * known area selection. Legacy classifiers may omit both fields.
   */
  gateConfidence?: number;
  areaConfidence?: number | null;
  abstentionReason?: string;
  durationMs: number;
  inputCharacters?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
}

export interface DenseVector {
  id: string;
  values: number[];
}

export interface ThresholdsV1 {
  minimumTopScore: number;
  minimumMargin: number;
  minimumSecondScoreForMultiArea: number;
  maximumSelectedAreas: 2;
}
