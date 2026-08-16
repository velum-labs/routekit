import { EVAL_SETUP_VERSION, type EvalSetupEvent } from "@velum-labs/routekit-eval-contracts";
import { Clock, Context, Effect, Layer, Path } from "effect";

import type { OriEvalResult } from "./ori-result.js";

import {
  type EvalSetupRunnerError,
  EvalSetupTransitionError
} from "./errors.js";
import {
  authoringRequest,
  type EvalHostMetadata,
  initialHostMetadata,
  loadHostMetadata,
  saveHostMetadata
} from "./host-metadata.js";
import { OriEvalAuthoring } from "./ori-authoring.js";
import { EvalSetupRunner } from "./runner.js";
import type {
  SetupAnswerResult,
  SetupEstimate,
  SetupQuestion,
  SetupRunResult,
  SetupStateView,
  SetupStatus
} from "./types.js";

const isoNow = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const questionFromResult = (result: OriEvalResult): SetupQuestion | undefined => {
  if (result.status !== "waiting") return undefined;
  const tag = asString(result.tag) ?? "untagged";
  const prompt = asString(result.prompt) ?? asString(result.question);
  if (prompt === undefined) return undefined;
  return {
    id: tag,
    prompt,
    options: asStringArray(result.options),
    ...(asString(result.context) === undefined ? {} : { context: asString(result.context) })
  };
};

const stageFromResult = (result: OriEvalResult | undefined, fallback: string): string => {
  if (result === undefined) return fallback;
  if (result.status === "waiting") return asString(result.tag) ?? "waiting";
  return asString(result.status) ?? fallback;
};

const stateView = (host: EvalHostMetadata, result?: OriEvalResult): SetupStateView => ({
  profileId: host.profileId,
  repositoryRoot: host.repositoryRoot,
  stage: stageFromResult(result ?? host.lastResult, host.lastResult === undefined ? "prepared" : "unknown"),
  revision: host.revision,
  updatedAt: host.updatedAt,
  answers: host.answers,
  ...(host.runDirectory === undefined ? {} : { runDirectory: host.runDirectory }),
  ...(host.scratchWorkspace === undefined ? {} : { scratchWorkspace: host.scratchWorkspace }),
  ...(host.publishApproved === undefined ? {} : { publishApproved: host.publishApproved })
});

const statusOf = (host: EvalHostMetadata, result?: OriEvalResult): SetupStatus => {
  const current = result ?? host.lastResult;
  const question = current === undefined ? undefined : questionFromResult(current);
  return {
    state: stateView(host, current),
    ...(question === undefined ? {} : { question }),
    ...(current === undefined ? {} : { result: current })
  };
};

const eventsFor = (host: EvalHostMetadata, result?: OriEvalResult): readonly EvalSetupEvent[] => {
  const question = result === undefined ? undefined : questionFromResult(result);
  const events: EvalSetupEvent[] = [];
  if (question !== undefined) {
    events.push({
      type: "question",
      stage: "surface",
      prompt: question.prompt
    });
  }
  if (result?.status === "completed") {
    events.push({ type: "completed", profileId: host.profileId });
  }
  return events;
};

const mergeHost = (
  host: EvalHostMetadata,
  result: OriEvalResult,
  now: string,
  answer?: string
): EvalHostMetadata => {
  const state = asRecord(result.state);
  const tag = asString(result.tag) ?? asString(host.lastResult?.tag);
  const rejected = result.status === "waiting" && result.accepted === false;
  return {
    ...host,
    revision: host.revision + (answer === undefined || rejected ? 0 : 1),
    updatedAt: now,
    answers:
      answer === undefined || tag === undefined || rejected
        ? host.answers
        : { ...host.answers, [tag]: answer },
    runDirectory: asString(result.runDirectory) ?? host.runDirectory,
    scratchWorkspace:
      asString(result.scratchWorkspace) ??
      asString(state?.scratchWorkspace) ??
      host.scratchWorkspace,
    lastResult: result
  };
};

const requireHost = (host: EvalHostMetadata | undefined, profileId: string): EvalHostMetadata => {
  if (host === undefined) {
    throw new EvalSetupTransitionError({
      stage: "absent",
      detail: `no setup exists for profile ${JSON.stringify(profileId)}`
    });
  }
  return host;
};

const requireResult = (host: EvalHostMetadata, detail: string): OriEvalResult => {
  if (host.lastResult === undefined) {
    throw new EvalSetupTransitionError({
      stage: host.lastResult === undefined ? "prepared" : stageFromResult(host.lastResult, "unknown"),
      detail
    });
  }
  return host.lastResult;
};

export type EvalSetupError = EvalSetupRunnerError | EvalSetupTransitionError;

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
    _mode?: "pilot" | "full"
  ) => Effect.Effect<SetupEstimate, EvalSetupError>;
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
  const authoring = yield* OriEvalAuthoring;
  const runner = yield* EvalSetupRunner;
  const paths = yield* Path.Path;

  const loadHost = (repositoryRoot: string, profileId: string) =>
    Effect.tryPromise({
      try: () => loadHostMetadata(repositoryRoot, profileId),
      catch: (cause) =>
        new EvalSetupTransitionError({
          stage: "absent",
          detail: cause instanceof Error ? cause.message : String(cause)
        })
    });

  const persist = (metadata: EvalHostMetadata) =>
    Effect.tryPromise({
      try: () => saveHostMetadata(metadata),
      catch: (cause) =>
        new EvalSetupTransitionError({
          stage: metadata.lastResult === undefined ? "prepared" : "unknown",
          detail: cause instanceof Error ? cause.message : String(cause)
        })
    });

  const prepare: EvalSetupShape["prepare"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const now = yield* isoNow;
      const existing = yield* loadHost(root, profileId);
      const host = existing ?? initialHostMetadata({ profileId, repositoryRoot: root, now });
      const result = yield* authoring.withAuthoring({ profileId, repositoryRoot: root }, (api) =>
        api.prepare({
          existing:
            existing === undefined
              ? undefined
              : existing.lastResult?.status === "completed" &&
                  existing.scratchWorkspace === undefined &&
                  (!Array.isArray(existing.lastResult.evalRuns) ||
                    existing.lastResult.evalRuns.length === 0)
                ? "archive"
                : "resume",
          repository: root,
          request: authoringRequest(profileId, host.objective)
        })
      );
      const next = mergeHost(host, result, now);
      yield* persist(next);
      return { ...statusOf(next, result), events: eventsFor(next, result) };
    });

  const status: EvalSetupShape["status"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const host = yield* loadHost(root, profileId);
      if (host === undefined) return undefined;
      if (host.runDirectory === undefined) return statusOf(host);
      const result = yield* authoring.withAuthoring({ profileId, repositoryRoot: root }, (api) =>
        api.status({ runDirectory: host.runDirectory, repository: root })
      );
      const next = mergeHost(host, result, yield* isoNow);
      yield* persist(next);
      return statusOf(next, result);
    });

  const answer: EvalSetupShape["answer"] = (repositoryRoot, profileId, answerText) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const host = requireHost(yield* loadHost(root, profileId), profileId);
      const current = requireResult(host, "setup has no Ori run to answer; call prepare then run");
      if (current.status === "completed") {
        return yield* new EvalSetupTransitionError({
          stage: "completed",
          detail: "setup is already completed"
        });
      }
      if (answerText.trim().length === 0) {
        return yield* new EvalSetupTransitionError({
          stage: stageFromResult(current, "waiting"),
          detail: "an answer must not be empty"
        });
      }
      const result = yield* authoring.withAuthoring({ profileId, repositoryRoot: root }, (api) =>
        api.answer({
          answer: answerText,
          repository: root,
          ...(host.runDirectory === undefined ? {} : { runDirectory: host.runDirectory })
        })
      );
      const next = mergeHost(host, result, yield* isoNow, answerText.trim());
      yield* persist(next);
      return { ...statusOf(next, result), events: eventsFor(next, result) };
    });

  const validate: EvalSetupShape["validate"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const host = requireHost(yield* loadHost(root, profileId), profileId);
      const result = requireResult(host, "validation uses Ori's dry-run after an artifact exists");
      yield* runner.validate(result);
      return { ...statusOf(host, result), events: [] };
    });

  const estimate: EvalSetupShape["estimate"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const host = requireHost(yield* loadHost(root, profileId), profileId);
      return yield* runner.estimate(
        requireResult(host, "estimates are the values Ori reports at its candidate approval step")
      );
    });

  const runApproved: EvalSetupShape["runApproved"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const host = requireHost(yield* loadHost(root, profileId), profileId);
      if (
        host.lastResult?.status === "completed" &&
        Array.isArray(host.lastResult.evalRuns) &&
        host.lastResult.evalRuns.length > 0
      ) {
        return yield* new EvalSetupTransitionError({
          stage: "completed",
          detail: "the Ori run is already completed"
        });
      }
      if (host.lastResult?.status === "waiting") {
        return yield* new EvalSetupTransitionError({
          stage: stageFromResult(host.lastResult, "waiting"),
          detail: "the run is waiting for a user answer; use eval answer"
        });
      }
      const result = yield* authoring.withAuthoring({ profileId, repositoryRoot: root }, (api) =>
        api.run({
          repository: root,
          ...(host.runDirectory === undefined ? {} : { runDirectory: host.runDirectory })
        })
      );
      const next = mergeHost(host, result, yield* isoNow);
      yield* persist(next);
      return { ...statusOf(next, result), events: eventsFor(next, result) };
    });

  const publishApproved: EvalSetupShape["publishApproved"] = (repositoryRoot, profileId) =>
    Effect.gen(function* () {
      const root = paths.resolve(repositoryRoot);
      const host = requireHost(yield* loadHost(root, profileId), profileId);
      const result = requireResult(host, "publication requires a completed Ori run");
      if (
        result.status !== "completed" ||
        result.ok !== true ||
        !Array.isArray(result.evalRuns) ||
        result.evalRuns.length === 0
      ) {
        return yield* new EvalSetupTransitionError({
          stage: stageFromResult(result, "unknown"),
          detail: "publication requires a successful completed Ori run with eval evidence"
        });
      }
      const published = yield* runner.publish({
        profileId,
        repositoryRoot: root,
        objective: host.objective,
        result
      });
      const next: EvalHostMetadata = {
        ...host,
        publishApproved: true,
        revision: host.revision + 1,
        updatedAt: yield* isoNow
      };
      yield* persist(next);
      return {
        ...statusOf(next, result),
        comparison: published.comparison,
        proposal: published.proposal,
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
