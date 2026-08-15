import type { EvalSetupStage, EvalSetupState } from "@velum-labs/routekit-eval-contracts";

import type { RepositoryInspection, SetupQuestion } from "./types.js";

const firstThree = (values: readonly string[], fallback: readonly [string, string, string]) => {
  const unique = [...new Set(values.filter((value) => value.trim().length > 0))].slice(0, 3);
  return [unique[0] ?? fallback[0], unique[1] ?? fallback[1], unique[2] ?? fallback[2]] as const;
};

export const questionForStage = (
  stage: EvalSetupStage,
  inspection?: RepositoryInspection
): SetupQuestion | undefined => {
  switch (stage) {
    case "surface":
      return {
        id: stage,
        prompt: "Which model-backed workflow should RouteKit optimize first?",
        options: firstThree(
          inspection?.surfaces.map((surface) =>
            surface.model === undefined
              ? `${surface.name} (${surface.path})`
              : `${surface.name} on ${surface.model}`
          ) ?? [],
          ["Repository default", "The primary user-facing flow", "Stop setup"]
        )
      };
    case "data":
      return {
        id: stage,
        prompt: "Which representative inputs should this eval measure?",
        options: firstThree(
          inspection?.materials.map((material) => `${material.path} (${material.kind})`) ?? [],
          ["Existing tests and fixtures", "Sanitized real examples", "Generate seed cases"]
        )
      };
    case "criteria":
      return {
        id: stage,
        prompt: "What makes an answer acceptable for this workflow?",
        options: ["Correct and complete", "Valid structured output", "Correct tool behavior"]
      };
    case "constraints":
      return {
        id: stage,
        prompt: "What should RouteKit optimize after candidates meet the quality floor?",
        options: ["Lowest cost", "Lowest latency", "Highest quality"]
      };
    case "candidates":
      return {
        id: stage,
        prompt:
          "Enter exactly three unique provider/model IDs: two candidates, then a distinct judge.",
        options: [
          "Compare my current model with one cheaper candidate",
          "Compare two models I name with a separate judge",
          "Help me find three explicit model IDs"
        ]
      };
    case "spend-approval":
      return {
        id: stage,
        prompt: "The suite is validated. How should RouteKit proceed with paid model calls?",
        options: ["Run a three-case pilot", "Run the full comparison", "Save without running"]
      };
    case "publish":
      return {
        id: stage,
        prompt: "Should RouteKit publish the proposed winner and fallbacks for this profile?",
        options: ["Publish this policy", "Keep the proposal unpublished", "Run another comparison"]
      };
    case "completed":
      return undefined;
  }
};

export const withOpenQuestion = (
  state: EvalSetupState,
  inspection?: RepositoryInspection
): { readonly state: EvalSetupState; readonly question?: SetupQuestion } => {
  const question = questionForStage(state.stage, inspection);
  if (question === undefined) return { state };
  return {
    state: { ...state, openQuestion: question.prompt },
    question
  };
};
