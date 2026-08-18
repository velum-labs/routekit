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
import { Data, Effect } from "effect";

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
export class CompositionalRoutingError extends Data.TaggedError(
  "CompositionalRoutingError"
)<{
  readonly code: CompositionalRoutingErrorCode;
  readonly message: string;
  readonly candidates: readonly RoutingCandidateDecision[];
}> {}

function validateMaximumUnknownWeight(value: number): Effect.Effect<void, CompositionalRoutingError> {
  return !Number.isFinite(value) || value < 0 || value > 1
    ? Effect.fail(
        new CompositionalRoutingError({
          code: "invalid_input",
          message: "maximum unknown weight must be a finite number between zero and one",
          candidates: []
        })
      )
    : Effect.void;
}

function validateContracts(
  input: CompositionalRoutingInput
): Effect.Effect<void, CompositionalRoutingError> {
  return Effect.try({
    try: () => {
      assertPublishedRoutingActivation(input.snapshot);
      assertRequestDecomposition(input.decomposition, {
        version: COMPOSITIONAL_ROUTING_VERSION,
        basisDigest: input.snapshot.basisDigest,
        dimensions: input.snapshot.dimensions
      });
      assertRoutingObjectivePolicy(input.objective);
    },
    catch: (cause) =>
      new CompositionalRoutingError({
        code: "invalid_input",
        message: cause instanceof Error ? cause.message : "invalid compositional routing input",
        candidates: []
      })
  });
}

/**
 * Compose a classifier-produced dimension vector with the published model-by-dimension
 * evidence matrix. Model selection is delegated exclusively to the pure,
 * deterministic eval-core scorer.
 */
export const routeCompositionalRequest = Effect.fn("Routing.compositional")(
  function* (input: CompositionalRoutingInput) {
    yield* validateMaximumUnknownWeight(input.maximumUnknownWeight);
    yield* validateContracts(input);
    if (input.decomposition.unknownWeight > input.maximumUnknownWeight) {
      return yield* new CompositionalRoutingError({
        code: "unknown_weight_above_maximum",
        message: "request is not sufficiently covered by the published routing dimensions",
        candidates: []
      });
    }

    const scored = yield* Effect.try({
      try: () =>
        scoreRoutingCandidates({
          snapshot: input.snapshot,
          decomposition: input.decomposition,
          requirements: input.requirements,
          objective: input.objective,
          availableModels: input.availableModels,
          ...(input.constraints === undefined ? {} : { constraints: input.constraints })
        }),
      catch: (cause) =>
        cause instanceof RoutingScoringError
          ? new CompositionalRoutingError({
              code: cause.code === "no_eligible_models" ? "no_eligible_models" : "invalid_input",
              message: cause.message,
              candidates: cause.candidates
            })
          : new CompositionalRoutingError({
              code: "invalid_input",
              message: cause instanceof Error ? cause.message : "compositional routing failed",
              candidates: []
            })
    });

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
    yield* Effect.try({
      try: () => assertAutoRoutingDecision(decision, input.snapshot),
      catch: (cause) =>
        new CompositionalRoutingError({
          code: "invalid_input",
          message: cause instanceof Error ? cause.message : "invalid compositional routing decision",
          candidates: []
        })
    });
    return decision;
  }
);
