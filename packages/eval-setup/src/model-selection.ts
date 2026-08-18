import { assertExplicitEvalModel } from "@velum-labs/routekit-eval-contracts";

const EXPLICIT_MODEL_ID = /\b[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._~:-]*\b/gu;
const FORBIDDEN_ALIAS_SEGMENTS = new Set(["auto", "default", "router"]);

export type EvalModelSelection = {
  readonly candidates: readonly [string, string];
  readonly judgeModel: string;
};

const assertNotAlias = (model: string): void => {
  const segments = model.toLowerCase().split("/");
  if (segments.some((segment) => FORBIDDEN_ALIAS_SEGMENTS.has(segment))) {
    throw new Error(
      `eval model must be a concrete provider/model id, not alias ${JSON.stringify(model)}`
    );
  }
};

export const assertEvalModelSelection = (
  candidates: readonly string[],
  judgeModel: string
): EvalModelSelection => {
  if (candidates.length !== 2) {
    throw new Error("provide exactly two candidate model ids");
  }
  const first = candidates[0];
  const second = candidates[1];
  if (first === undefined || second === undefined) {
    throw new Error("provide exactly two candidate model ids");
  }
  assertExplicitEvalModel(first, "candidate");
  assertExplicitEvalModel(second, "candidate");
  assertExplicitEvalModel(judgeModel, "judge");
  assertNotAlias(first);
  assertNotAlias(second);
  assertNotAlias(judgeModel);
  const unique = new Set([first, second, judgeModel].map((model) => model.toLowerCase()));
  if (unique.size !== 3) {
    throw new Error(
      "candidate and judge roles require three unique model ids; the judge must differ from both candidates"
    );
  }
  return { candidates: [first, second], judgeModel };
};

export const modelSelectionFromAnswer = (answer: string): EvalModelSelection => {
  const modelIds = answer.match(EXPLICIT_MODEL_ID) ?? [];
  if (modelIds.length !== 3) {
    throw new Error(
      "provide exactly three explicit provider/model ids: two candidates followed by one distinct judge"
    );
  }
  return assertEvalModelSelection(modelIds.slice(0, 2), modelIds[2] ?? "");
};
