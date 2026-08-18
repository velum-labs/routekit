import {
  type AutoRoutingDecision,
  assertAutoRoutingDecision,
  assertPublishedRoutingActivation,
  assertRequestDecomposition,
  assertRoutingObjectivePolicy,
  COMPOSITIONAL_ROUTING_VERSION,
  type PublishedRoutingActivation,
  type RequestDecomposition,
  type RequestRoutingRequirements,
  type RoutingCandidateDecision,
  type RoutingObjectivePolicy
} from "@velum-labs/routekit-eval-contracts";
import {
  type RoutingModelAvailability,
  type RoutingScoreConstraints,
  RoutingScoringError,
  scoreRoutingCandidates
} from "@velum-labs/routekit-eval-core";

export type CompositionalRoutingInput = Readonly<{
  snapshot: PublishedRoutingActivation;
  decomposition: RequestDecomposition;
  requirements: RequestRoutingRequirements;
  objective: RoutingObjectivePolicy;
  availableModels: readonly RoutingModelAvailability[];
  maximumUnknownWeight: number;
  constraints?: RoutingScoreConstraints;
}>;

export type CompositionalRoutingErrorCode =
  | "invalid_input"
  | "unknown_weight_above_maximum"
  | "no_eligible_models";

/**
 * Sanitized deterministic-routing failure. Candidate outputs, request text,
 * provider errors, and other request content are deliberately not retained.
 */
export class CompositionalRoutingError extends Error {
  readonly code: CompositionalRoutingErrorCode;
  readonly candidates: readonly RoutingCandidateDecision[];

  constructor(
    code: CompositionalRoutingErrorCode,
    message: string,
    candidates: readonly RoutingCandidateDecision[] = []
  ) {
    super(message);
    this.name = "CompositionalRoutingError";
    this.code = code;
    this.candidates = candidates;
  }
}

function validateMaximumUnknownWeight(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CompositionalRoutingError(
      "invalid_input",
      "maximum unknown weight must be a finite number between zero and one"
    );
  }
}

function validateContracts(input: CompositionalRoutingInput): void {
  try {
    assertPublishedRoutingActivation(input.snapshot);
    assertRequestDecomposition(input.decomposition, {
      version: COMPOSITIONAL_ROUTING_VERSION,
      basisDigest: input.snapshot.basisDigest,
      dimensions: input.snapshot.dimensions
    });
    assertRoutingObjectivePolicy(input.objective);
  } catch (cause) {
    throw new CompositionalRoutingError(
      "invalid_input",
      cause instanceof Error ? cause.message : "invalid compositional routing input"
    );
  }
}

/**
 * Compose a classifier-produced dimension vector with the published model-by-dimension
 * evidence matrix. Model selection is delegated exclusively to the pure,
 * deterministic eval-core scorer.
 */
export function routeCompositionalRequest(input: CompositionalRoutingInput): AutoRoutingDecision {
  validateMaximumUnknownWeight(input.maximumUnknownWeight);
  validateContracts(input);
  if (input.decomposition.unknownWeight > input.maximumUnknownWeight) {
    throw new CompositionalRoutingError(
      "unknown_weight_above_maximum",
      "request is not sufficiently covered by the published routing dimensions"
    );
  }

  let scored: ReturnType<typeof scoreRoutingCandidates>;
  try {
    scored = scoreRoutingCandidates({
      snapshot: input.snapshot,
      decomposition: input.decomposition,
      requirements: input.requirements,
      objective: input.objective,
      availableModels: input.availableModels,
      ...(input.constraints === undefined ? {} : { constraints: input.constraints })
    });
  } catch (cause) {
    if (cause instanceof RoutingScoringError) {
      throw new CompositionalRoutingError(
        cause.code === "no_eligible_models" ? "no_eligible_models" : "invalid_input",
        cause.message,
        cause.candidates
      );
    }
    throw new CompositionalRoutingError(
      "invalid_input",
      cause instanceof Error ? cause.message : "compositional routing failed"
    );
  }

  const decision: AutoRoutingDecision = {
    version: COMPOSITIONAL_ROUTING_VERSION,
    decomposition: input.decomposition,
    requirements: input.requirements,
    objective: input.objective,
    evidenceDigest: input.snapshot.evidenceDigest,
    candidates: scored.candidates,
    selectedModel: scored.selectedModel,
    fallbackModels: scored.fallbackModels
  };
  try {
    assertAutoRoutingDecision(decision, input.snapshot);
  } catch (cause) {
    throw new CompositionalRoutingError(
      "invalid_input",
      cause instanceof Error ? cause.message : "invalid compositional routing decision"
    );
  }
  return decision;
}
