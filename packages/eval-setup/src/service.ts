import {
  EVAL_SETUP_VERSION,
  type EvalComparisonResult,
  type EvalSetupEvent,
  type EvalSetupRunMode,
  type EvalSetupStage,
  type EvalSetupState,
  type RoutingObjective
} from "@velum-labs/routekit-eval-contracts";
import { Clock, Context, Effect, Layer, Path } from "effect";

import {
  type EvalSetupInspectionError,
  type EvalSetupRunnerError,
  type EvalSetupScaffoldError,
  type EvalSetupStateError,
  EvalSetupTransitionError
} from "./errors.js";
import { EvalRepositoryInspector } from "./inspection.js";
import { modelSelectionFromAnswer } from "./model-selection.js";
import { questionForStage } from "./questions.js";
import { EvalSetupRunner } from "./runner.js";
import { EvalSetupScaffolder } from "./scaffold.js";
import { EvalSetupStateStore, initialSetupState } from "./state-store.js";
import type {
  RepositoryInspection,
  ScaffoldInput,
  ScaffoldResult,
  SetupAnswerResult,
  SetupRunResult,
  SetupStatus
} from "./types.js";

const STAGE_ORDER = [
  "surface",
  "data",
  "criteria",
  "constraints",
  "candidates",
  "spend-approval",
  "publish",
  "completed"
] as const satisfies readonly EvalSetupStage[];

const answerKey = (stage: EvalSetupStage): string => stage;

const nextStage = (stage: EvalSetupStage): EvalSetupStage => {
  const index = STAGE_ORDER.indexOf(stage);
  return STAGE_ORDER[index + 1] ?? "completed";
};

const isoNow = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

const normalizeAnswer = (answer: string): string => answer.replaceAll(/\s+/gu, " ").trim();

const parseObjective = (answer: string): RoutingObjective => {
  const normalized = answer.toLowerCase();
  if (normalized.includes("latency") || normalized.includes("fast")) return "lowest-latency";
  if (normalized.includes("quality") || normalized.includes("strong")) return "highest-quality";
  return "lowest-cost";
};

const runModeFromAnswer = (answer: string): EvalSetupRunMode => {
  const normalized = answer.toLowerCase();
  if (normalized.includes("full") || normalized === "2") return "full";
  if (normalized.includes("save") || normalized.includes("without") || normalized === "3") {
    return "save-only";
  }
  return "pilot";
};

const publishApprovedFromAnswer = (answer: string): boolean => {
  const normalized = answer.toLowerCase();
  return normalized.includes("publish") || normalized === "1" || normalized === "yes";
};

const questionEvent = (
  stage: EvalSetupStage,
  inspection?: RepositoryInspection
): EvalSetupEvent | undefined => {
  const question = questionForStage(stage, inspection);
  return question === undefined ? undefined : { type: "question", stage, prompt: question.prompt };
};

const statusOf = (state: EvalSetupState, inspection?: RepositoryInspection): SetupStatus => {
  const question = questionForStage(state.stage, inspection);
  return {
    state,
    ...(question === undefined ? {} : { question }),
    ...(inspection === undefined ? {} : { inspection })
  };
};

const persistQuestion = Effect.fn("EvalSetup.persistQuestion")(function* (
  store: EvalSetupStateStore["Service"],
  state: EvalSetupState,
  inspection?: RepositoryInspection
) {
  const question = questionForStage(state.stage, inspection);
  const next = {
    ...state,
    ...(question === undefined ? {} : { openQuestion: question.prompt })
  };
  yield* store.save(next);
  return next;
});

const requireState = Effect.fn("EvalSetup.requireState")(function* (
  store: EvalSetupStateStore["Service"],
  repositoryRoot: string,
  profileId: string
) {
  const state = yield* store.load(repositoryRoot, profileId);
  if (state === undefined) {
    return yield* new EvalSetupTransitionError({
      stage: "absent",
      detail: `no setup exists for profile ${JSON.stringify(profileId)}`
    });
  }
  return state;
});

const scaffoldInputFromState = (state: EvalSetupState): ScaffoldInput => {
  let selection;
  try {
    selection = modelSelectionFromAnswer(state.answers.candidates ?? "");
  } catch (cause) {
    throw new EvalSetupTransitionError({
      stage: "candidates",
      detail: cause instanceof Error ? cause.message : String(cause)
    });
  }
  return {
    profileId: state.profileId,
    repositoryRoot: state.repositoryRoot,
    surface: state.answers.surface ?? "repository workflow",
    dataSource: state.answers.data ?? "generated seed cases",
    criteria: state.answers.criteria ?? "The answer is correct and complete.",
    constraint: state.answers.constraints ?? "Meet the configured quality floor.",
    candidates: selection.candidates,
    judgeModel: selection.judgeModel,
    objective: parseObjective(state.answers.constraints ?? "lowest cost")
  };
};

const scaffoldFromState = Effect.fn("EvalSetup.scaffoldFromState")(function* (
  scaffolder: EvalSetupScaffolder["Service"],
  state: EvalSetupState
) {
  return yield* Effect.try({
    try: () => scaffoldInputFromState(state),
    catch: (cause) =>
      cause instanceof EvalSetupTransitionError
        ? cause
        : new EvalSetupTransitionError({ stage: state.stage, detail: String(cause) })
  }).pipe(Effect.flatMap(scaffolder.scaffold));
});

const scaffoldResultFromState = (
  paths: Path.Path,
  state: EvalSetupState
): Effect.Effect<ScaffoldResult, EvalSetupTransitionError> => {
  if (state.generatedEvalPath === undefined || state.generatedProfilePath === undefined) {
    return Effect.fail(
      new EvalSetupTransitionError({
        stage: state.stage,
        detail: "setup artifacts have not been generated"
      })
    );
  }
  let input: ScaffoldInput;
  try {
    input = scaffoldInputFromState(state);
  } catch (cause) {
    return Effect.fail(
      cause instanceof EvalSetupTransitionError
        ? cause
        : new EvalSetupTransitionError({ stage: state.stage, detail: String(cause) })
    );
  }
  const artifactPaths = {
    evalPath: state.generatedEvalPath,
    profilePath: state.generatedProfilePath
  };
  return Effect.succeed({
    ...artifactPaths,
    profile: {
      version: 1,
      id: input.profileId,
      suite: paths
        .relative(state.repositoryRoot, state.generatedEvalPath)
        .split(paths.sep)
        .join("/"),
      candidates: [...input.candidates],
      judge: input.judgeModel,
      eligibility: {},
      objective: input.objective
    }
  });
};

export type EvalSetupError =
  | EvalSetupInspectionError
  | EvalSetupRunnerError
  | EvalSetupScaffoldError
  | EvalSetupStateError
  | EvalSetupTransitionError;

export type EvalSetupShape = {
  readonly prepare: (
    repositoryRoot: string,
    profileId: string
  ) => Effect.Effect<SetupAnswerResult, EvalSetupError>;
  readonly status: (
    repositoryRoot: string,
    profileId: string
  ) => Effect.Effect<SetupStatus | undefined, EvalSetupError>;
  readonly answer: (
    repositoryRoot: string,
    profileId: string,
    answer: string
  ) => Effect.Effect<SetupAnswerResult, EvalSetupError>;
  readonly validate: (
    repositoryRoot: string,
    profileId: string
  ) => Effect.Effect<SetupAnswerResult, EvalSetupError>;
  readonly estimate: (
    repositoryRoot: string,
    profileId: string,
    mode: Exclude<EvalSetupRunMode, "save-only">
  ) => Effect.Effect<import("./types.js").SetupEstimate, EvalSetupError>;
  readonly runApproved: (
    repositoryRoot: string,
    profileId: string
  ) => Effect.Effect<SetupRunResult, EvalSetupError>;
  readonly publishApproved: (
    repositoryRoot: string,
    profileId: string
  ) => Effect.Effect<SetupRunResult, EvalSetupError>;
};

export class EvalSetup extends Context.Service<EvalSetup, EvalSetupShape>()(
  "@velum-labs/routekit-eval-setup/EvalSetup"
) {}

export const makeEvalSetup = Effect.gen(function* () {
  const store = yield* EvalSetupStateStore;
  const inspector = yield* EvalRepositoryInspector;
  const scaffolder = yield* EvalSetupScaffolder;
  const runner = yield* EvalSetupRunner;
  const paths = yield* Path.Path;

  const loadInspection = (repositoryRoot: string) => inspector.inspect(repositoryRoot);

  const prepare: EvalSetupShape["prepare"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const existing = yield* store.load(root, profileId);
      const inspection = yield* loadInspection(root);
      const now = yield* isoNow;
      const base = existing ?? initialSetupState({ profileId, repositoryRoot: root, now });
      const state = yield* persistQuestion(store, base, inspection);
      const event = questionEvent(state.stage, inspection);
      return {
        ...statusOf(state, inspection),
        events: event === undefined ? [] : [event]
      };
    });

  const status: EvalSetupShape["status"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const state = yield* store.load(root, profileId);
      if (state === undefined) return undefined;
      const inspection = yield* loadInspection(root);
      return statusOf(state, inspection);
    });

  const answer: EvalSetupShape["answer"] = (repositoryRoot, profileId, answerText) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const state = yield* requireState(store, root, profileId);
      if (state.stage === "completed") {
        return yield* new EvalSetupTransitionError({
          stage: state.stage,
          detail: "setup is already completed"
        });
      }
      const answer = normalizeAnswer(answerText);
      if (answer.length === 0) {
        return yield* new EvalSetupTransitionError({
          stage: state.stage,
          detail: "an answer must not be empty"
        });
      }
      const expectedQuestion = questionForStage(state.stage);
      if (state.openQuestion === undefined || expectedQuestion?.prompt !== state.openQuestion) {
        return yield* new EvalSetupTransitionError({
          stage: state.stage,
          detail: "setup has no matching open question; call prepare or status first"
        });
      }
      const now = yield* isoNow;
      let next: EvalSetupState = {
        ...state,
        stage: nextStage(state.stage),
        revision: state.revision + 1,
        updatedAt: now,
        answers: { ...state.answers, [answerKey(state.stage)]: answer }
      };
      const events: EvalSetupEvent[] = [];
      if (state.stage === "candidates") {
        const scaffold = yield* scaffoldFromState(scaffolder, next);
        yield* runner.validate(scaffold);
        next = {
          ...next,
          generatedEvalPath: scaffold.evalPath,
          generatedProfilePath: scaffold.profilePath
        };
        events.push({
          type: "artifacts-generated",
          evalPath: scaffold.evalPath,
          profilePath: scaffold.profilePath
        });
      }
      if (state.stage === "spend-approval") {
        const mode = runModeFromAnswer(answer);
        next = {
          ...next,
          runMode: mode,
          stage: mode === "save-only" ? "completed" : "spend-approval",
          openQuestion: undefined
        };
        events.push({ type: "run-approved", mode });
      }
      if (state.stage === "publish") {
        const approved = publishApprovedFromAnswer(answer);
        next = {
          ...next,
          publishApproved: approved,
          stage: approved ? "publish" : "completed",
          openQuestion: undefined
        };
      }
      const inspection = yield* loadInspection(root);
      if (next.stage === "spend-approval" && next.runMode !== undefined) {
        yield* store.save(next);
      } else if (next.stage === "publish" && next.publishApproved === true) {
        yield* store.save(next);
      } else {
        next = yield* persistQuestion(store, next, inspection);
        const event = questionEvent(next.stage, inspection);
        if (event !== undefined) events.push(event);
      }
      if (next.stage === "completed") events.push({ type: "completed", profileId });
      return { ...statusOf(next, inspection), events };
    });

  const validate: EvalSetupShape["validate"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const state = yield* requireState(store, root, profileId);
      const scaffold = yield* scaffoldResultFromState(paths, state);
      yield* runner.validate(scaffold);
      return { ...statusOf(state), events: [] };
    });

  const estimate: EvalSetupShape["estimate"] = (repositoryRoot, profileId, mode) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const state = yield* requireState(store, root, profileId);
      const scaffold = yield* scaffoldResultFromState(paths, state);
      return yield* runner.estimate(scaffold, mode);
    });

  const runApproved: EvalSetupShape["runApproved"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const state = yield* requireState(store, root, profileId);
      if (state.stage !== "spend-approval" || state.runMode === undefined) {
        return yield* new EvalSetupTransitionError({
          stage: state.stage,
          detail: "paid execution requires an approved pilot or full run"
        });
      }
      if (state.runMode === "save-only") {
        return yield* new EvalSetupTransitionError({
          stage: state.stage,
          detail: "save-only setup cannot execute model calls"
        });
      }
      if (state.comparisonId !== undefined) {
        return yield* new EvalSetupTransitionError({
          stage: state.stage,
          detail: "this approved run has already completed"
        });
      }
      const scaffold = yield* scaffoldResultFromState(paths, state);
      const comparison: EvalComparisonResult = yield* state.runMode === "pilot"
        ? runner.runPilot(scaffold)
        : runner.runFull(scaffold);
      const proposal = yield* runner.propose(scaffold, comparison);
      yield* store.saveRun(root, profileId, { comparison, proposal });
      const next: EvalSetupState = yield* persistQuestion(store, {
        ...state,
        stage: "publish",
        comparisonId: comparison.comparisonId,
        revision: state.revision + 1,
        updatedAt: yield* isoNow
      });
      const question = questionEvent("publish");
      return {
        ...statusOf(next),
        comparison,
        proposal,
        events: [
          { type: "comparison-completed", comparisonId: comparison.comparisonId },
          ...(question === undefined ? [] : [question])
        ]
      };
    });

  const publishApproved: EvalSetupShape["publishApproved"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const state = yield* requireState(store, root, profileId);
      if (!state.publishApproved || state.comparisonId === undefined) {
        return yield* new EvalSetupTransitionError({
          stage: state.stage,
          detail: "publication requires an explicit publish answer after a completed comparison"
        });
      }
      const checkpoint = yield* store.loadRun(root, profileId);
      if (checkpoint === undefined || checkpoint.comparison.comparisonId !== state.comparisonId) {
        return yield* new EvalSetupTransitionError({
          stage: state.stage,
          detail: "the approved comparison checkpoint is missing or does not match setup state"
        });
      }
      const { comparison, proposal } = checkpoint;
      yield* runner.publish(proposal);
      const next: EvalSetupState = {
        ...state,
        stage: "completed",
        revision: state.revision + 1,
        updatedAt: yield* isoNow
      };
      yield* store.save(next);
      return {
        ...statusOf(next),
        comparison,
        proposal,
        events: [
          { type: "publish-approved", profileId },
          { type: "completed", profileId }
        ]
      };
    });

  return EvalSetup.of({
    prepare,
    status,
    answer,
    validate,
    estimate,
    runApproved,
    publishApproved
  });
});

export const EvalSetupLive = Layer.effect(EvalSetup, makeEvalSetup);

export { EVAL_SETUP_VERSION };
