import type { IncomingHttpHeaders } from "node:http";

import type { RequestAttribution } from "@velum-labs/routekit-contracts";
import {
  COMPOSITIONAL_ROUTING_VERSION,
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY_BYPASS_HEADER,
  isForbiddenEvalModel,
  type AutoRoutingDecisionV2,
  type PublishedRoutingSnapshotV2,
  type RequestRoutingRequirements,
  type RoutingObjectivePolicy,
  type PublishedRoutingProfile
} from "@velum-labs/routekit-eval-contracts";
import type {
  RoutingModelAvailability,
  RoutingScoreConstraints
} from "@velum-labs/routekit-eval-core";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Data, Effect } from "effect";

import {
  CompositionalRoutingError,
  routeCompositionalRequest
} from "./compositional-routing.js";
import {
  AreaRequestClassifier,
  type AreaRequestClassifierService,
  argmaxClassification,
  classifiableProfilesFromPublished,
  classifyRequest,
  classifyRequestAreas,
  RequestClassifier,
  type RequestClassifierService,
  validateAreaClassificationResult,
  validateClassifiableProfiles,
  validateClassificationResult
} from "./request-classifier.js";

export class RoutingPolicyReadError extends Data.TaggedError("RoutingPolicyReadError")<{
  readonly profileId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Online-only projection of the published routing snapshot store. */
export type RoutingPolicyReader = Readonly<{
  listProfiles(): Effect.Effect<
    Readonly<Record<string, PublishedRoutingProfile>>,
    RoutingPolicyReadError,
    RouteKitPlatform
  >;
  getProfile(
    profileId: string
  ): Effect.Effect<PublishedRoutingProfile | undefined, RoutingPolicyReadError, RouteKitPlatform>;
}>;

export function routingPolicyReaderFromMap(
  profiles: Readonly<Record<string, PublishedRoutingProfile>>
): RoutingPolicyReader {
  return {
    listProfiles: () => Effect.succeed(profiles),
    getProfile: (profileId) => Effect.succeed(profiles[profileId])
  };
}

/** Read-only online projection for the independently versioned v2 snapshot. */
export type CompositionalRoutingPolicyReader = Readonly<{
  getSnapshot(): Effect.Effect<
    PublishedRoutingSnapshotV2 | undefined,
    RoutingPolicyReadError,
    RouteKitPlatform
  >;
}>;

export function compositionalRoutingPolicyReaderFromSnapshot(
  snapshot: PublishedRoutingSnapshotV2 | undefined
): CompositionalRoutingPolicyReader {
  return {
    getSnapshot: () => Effect.succeed(snapshot)
  };
}

export class MissingRoutingProfileError extends Data.TaggedError("MissingRoutingProfileError")<{
  readonly message: string;
}> {}

export class UnknownRoutingProfileError extends Data.TaggedError("UnknownRoutingProfileError")<{
  readonly profileId: string;
  readonly message: string;
}> {}

export class AutoRoutingUnavailableError extends Data.TaggedError("AutoRoutingUnavailableError")<{
  readonly profileId: string | undefined;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class EvalAutoRoutingForbiddenError extends Data.TaggedError(
  "EvalAutoRoutingForbiddenError"
)<{
  readonly message: string;
}> {}

export type AutoRoutingDecision = Readonly<{
  profileId: string;
  selectedModel: string;
  evidenceDigest: string;
  scores: readonly Readonly<{ profileId: string; probability: number }>[];
}>;

export type CompositionalRoutingMode = "shadow" | "active";

export type CompositionalRoutingObservation =
  | Readonly<{
      mode: CompositionalRoutingMode;
      status: "decided";
      decision: AutoRoutingDecisionV2;
      classifierCallId?: string;
    }>
  | Readonly<{
      mode: CompositionalRoutingMode;
      status: "failed";
      message: string;
    }>;

export type CompositionalRoutingRuntime = Readonly<{
  mode: CompositionalRoutingMode;
  policyReader?: CompositionalRoutingPolicyReader;
  classifier?: AreaRequestClassifierService;
  availableModels: readonly RoutingModelAvailability[];
  objective: RoutingObjectivePolicy;
  maximumUnknownWeight: number;
  constraints?: RoutingScoreConstraints;
  onObservation?(observation: CompositionalRoutingObservation): void;
}>;

export function compositionalRoutingAttribution(
  observation: Extract<CompositionalRoutingObservation, { status: "decided" }>
): NonNullable<RequestAttribution["compositional_routing"]> {
  const { decision } = observation;
  const objective =
    decision.objective.kind === "highest-quality"
      ? decision.objective
      : decision.objective.kind === "balanced"
        ? {
            kind: decision.objective.kind,
            minimum_quality: decision.objective.minimumQuality,
            weights: decision.objective.weights
          }
        : decision.objective.kind === "pareto"
          ? {
              kind: decision.objective.kind,
              minimum_quality: decision.objective.minimumQuality,
              preference: decision.objective.preference
            }
          : {
              kind: decision.objective.kind,
              minimum_quality: decision.objective.minimumQuality
            };
  return {
    version: COMPOSITIONAL_ROUTING_VERSION,
    mode: observation.mode,
    definition_set_digest: decision.decomposition.definitionSetDigest,
    evidence_digest: decision.evidenceDigest,
    weights: decision.decomposition.weights.map((entry) => ({
      area_id: entry.areaId,
      weight: entry.weight
    })),
    unknown_weight: decision.decomposition.unknownWeight,
    requirements: {
      endpoint: decision.requirements.endpoint,
      requires_tools: decision.requirements.requiresTools,
      requires_vision: decision.requirements.requiresVision,
      ...(decision.requirements.inputTokens === undefined
        ? {}
        : { input_tokens: decision.requirements.inputTokens }),
      ...(decision.requirements.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: decision.requirements.maxOutputTokens })
    },
    objective,
    candidates: decision.candidates.map((candidate) => ({
      model: candidate.model,
      eligible: candidate.eligible,
      exclusion_reasons: [...candidate.exclusionReasons],
      ...(candidate.quality === undefined ? {} : { quality: candidate.quality }),
      ...(candidate.failureRate === undefined ? {} : { failure_rate: candidate.failureRate }),
      ...(candidate.p95DurationMs === undefined
        ? {}
        : { p95_duration_ms: candidate.p95DurationMs }),
      ...(candidate.averageCostUsd === undefined
        ? {}
        : { average_cost_usd: candidate.averageCostUsd }),
      cost_status: candidate.costStatus,
      ...(candidate.utility === undefined ? {} : { utility: candidate.utility }),
      ...(candidate.rank === undefined ? {} : { rank: candidate.rank })
    })),
    selected_model: decision.selectedModel,
    fallback_models: [...decision.fallbackModels],
    ...(observation.classifierCallId === undefined
      ? {}
      : { classifier_call_id: observation.classifierCallId })
  };
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = raw?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

export function evalPolicyBypassRequested(headers: IncomingHttpHeaders): boolean {
  const raw = firstHeader(headers, EVAL_POLICY_BYPASS_HEADER);
  return raw === "1" || raw?.toLowerCase() === "true";
}

export function evalRequestAttribution(
  headers: IncomingHttpHeaders
): NonNullable<RequestAttribution["eval"]> | undefined {
  if (!evalPolicyBypassRequested(headers)) return undefined;
  const raw = firstHeader(headers, EVAL_ATTRIBUTION_HEADER);
  if (raw === undefined || raw.length > 2_048) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const role = value.role;
    const runId = typeof value.runId === "string" ? value.runId.trim() : "";
    const caseId = typeof value.caseId === "string" ? value.caseId.trim() : undefined;
    if (
      value.purpose !== "eval" ||
      (role !== "author" && role !== "candidate" && role !== "judge") ||
      runId.length === 0 ||
      runId.length > 128 ||
      (caseId !== undefined && (caseId.length === 0 || caseId.length > 256))
    ) {
      return undefined;
    }
    return {
      purpose: "eval",
      role,
      run_id: runId,
      ...(caseId === undefined ? {} : { case_id: caseId }),
      policy_bypass: true
    };
  } catch {
    return undefined;
  }
}

/** Reject eval traffic that would fall through to the auto-router. */
export function evalAutoRouterRejection(
  headers: IncomingHttpHeaders,
  model: unknown
): string | undefined {
  if (!evalPolicyBypassRequested(headers)) return undefined;
  if (typeof model !== "string" || isForbiddenEvalModel(model)) {
    return "eval requests must name an explicit provider/model id";
  }
  return undefined;
}

function firstServedModel(
  profile: PublishedRoutingProfile,
  servesModel: (model: string) => boolean
): string | undefined {
  const ranked = [profile.selectedModel, ...profile.fallbackModels];
  return ranked.find((model, index) => ranked.indexOf(model) === index && servesModel(model));
}

/**
 * Resolve `model: "auto"` by classifying the request against every published
 * profile, then selecting that profile's compiled winner. Explicit model
 * requests are returned untouched.
 */
export function resolveAutoRoutingModel(
  options: Readonly<{
    headers: IncomingHttpHeaders;
    model: string | undefined;
    requestText?: string;
    policyReader?: RoutingPolicyReader;
    classifier?: RequestClassifierService;
    servesModel(model: string): boolean;
    onDecision?(decision: AutoRoutingDecision): void;
  }>
): Effect.Effect<
  string | undefined,
  | AutoRoutingUnavailableError
  | EvalAutoRoutingForbiddenError
  | MissingRoutingProfileError
  | UnknownRoutingProfileError,
  RouteKitPlatform
> {
  if (options.model?.trim().toLowerCase() !== "auto") {
    return Effect.succeed(options.model);
  }
  if (evalPolicyBypassRequested(options.headers)) {
    return Effect.fail(
      new EvalAutoRoutingForbiddenError({
        message: "eval requests must name an explicit provider/model id"
      })
    );
  }
  const reader = options.policyReader;
  const classifier = options.classifier;
  if (reader === undefined || classifier === undefined) {
    return Effect.fail(
      new AutoRoutingUnavailableError({
        profileId: undefined,
        message: "automatic model routing is not configured"
      })
    );
  }
  const requestText = options.requestText?.trim() ?? "";
  if (requestText.length === 0) {
    return Effect.fail(
      new AutoRoutingUnavailableError({
        profileId: undefined,
        message: 'model "auto" requires classifiable request text'
      })
    );
  }
  return Effect.gen(function* () {
    const readProfiles = yield* Effect.try({
      try: () => reader.listProfiles(),
      catch: (cause) =>
        new AutoRoutingUnavailableError({
          profileId: undefined,
          message: "failed to read published routing profiles",
          cause
        })
    });
    const published = yield* readProfiles.pipe(
      Effect.mapError(
        (cause) =>
          new AutoRoutingUnavailableError({
            profileId: undefined,
            message: "failed to read published routing profiles",
            cause
          })
      )
    );
    const profiles = yield* validateClassifiableProfiles(
      classifiableProfilesFromPublished(published)
    ).pipe(
      Effect.mapError(
        (error) =>
          new AutoRoutingUnavailableError({
            profileId: undefined,
            message:
              error.message === "no routing profiles to classify"
                ? "no published routing profiles are available"
                : error.message,
            cause: error
          })
      )
    );
    const classified = yield* classifyRequest({ request: requestText, profiles }).pipe(
      Effect.provideService(RequestClassifier, RequestClassifier.of(classifier)),
      Effect.mapError(
        (error) =>
          new AutoRoutingUnavailableError({
            profileId: undefined,
            message: error.message,
            cause: error
          })
      )
    );
    const validated = yield* validateClassificationResult(
      classified,
      profiles.map((profile) => profile.id)
    ).pipe(
      Effect.mapError(
        (error) =>
          new AutoRoutingUnavailableError({
            profileId: undefined,
            message: error.message,
            cause: error
          })
      )
    );
    const selected = argmaxClassification(validated.scores);
    if (selected === undefined) {
      return yield* new AutoRoutingUnavailableError({
        profileId: undefined,
        message: "request classification produced no profile"
      });
    }
    const profile = published[selected.profileId];
    if (profile === undefined) {
      return yield* new UnknownRoutingProfileError({
        profileId: selected.profileId,
        message: `unknown routing profile: ${selected.profileId}`
      });
    }
    const model = firstServedModel(profile, options.servesModel);
    if (model === undefined) {
      return yield* new AutoRoutingUnavailableError({
        profileId: selected.profileId,
        message: `no model is available for routing profile: ${selected.profileId}`
      });
    }
    options.onDecision?.({
      profileId: selected.profileId,
      selectedModel: model,
      evidenceDigest: profile.evidenceDigest,
      scores: validated.scores
    });
    return model;
  });
}

/**
 * Resolve `model: "auto"` against a v2 model-by-area evidence matrix.
 *
 * This entry point is intentionally separate from the v1 profile resolver so
 * activating v2 cannot reinterpret or overwrite an existing v1 snapshot.
 */
export function resolveCompositionalAutoRoutingModel(
  options: Readonly<{
    headers: IncomingHttpHeaders;
    model: string | undefined;
    requestText?: string;
    requirements: RequestRoutingRequirements;
    policyReader?: CompositionalRoutingPolicyReader;
    classifier?: AreaRequestClassifierService;
    availableModels: readonly RoutingModelAvailability[];
    objective: RoutingObjectivePolicy;
    maximumUnknownWeight: number;
    constraints?: RoutingScoreConstraints;
    onDecision?(decision: AutoRoutingDecisionV2, classifierCallId?: string): void;
  }>
): Effect.Effect<
  string | undefined,
  AutoRoutingUnavailableError | EvalAutoRoutingForbiddenError,
  RouteKitPlatform
> {
  if (options.model?.trim().toLowerCase() !== "auto") {
    return Effect.succeed(options.model);
  }
  if (evalPolicyBypassRequested(options.headers)) {
    return Effect.fail(
      new EvalAutoRoutingForbiddenError({
        message: "eval requests must name an explicit provider/model id"
      })
    );
  }
  if (options.policyReader === undefined || options.classifier === undefined) {
    return Effect.fail(
      new AutoRoutingUnavailableError({
        profileId: undefined,
        message: "compositional automatic model routing is not configured"
      })
    );
  }
  const requestText = options.requestText?.trim() ?? "";
  if (requestText.length === 0) {
    return Effect.fail(
      new AutoRoutingUnavailableError({
        profileId: undefined,
        message: 'model "auto" requires classifiable request text'
      })
    );
  }

  const reader = options.policyReader;
  const classifier = options.classifier;
  return Effect.gen(function* () {
    const readSnapshot = yield* Effect.try({
      try: () => reader.getSnapshot(),
      catch: (cause) =>
        new AutoRoutingUnavailableError({
          profileId: undefined,
          message: "failed to read the compositional routing snapshot",
          cause
        })
    });
    const snapshot = yield* readSnapshot.pipe(
      Effect.mapError(
        (cause) =>
          new AutoRoutingUnavailableError({
            profileId: undefined,
            message: "failed to read the compositional routing snapshot",
            cause
          })
      )
    );
    if (snapshot === undefined) {
      return yield* new AutoRoutingUnavailableError({
        profileId: undefined,
        message: "no compositional routing snapshot is available"
      });
    }

    const classified = yield* classifyRequestAreas({
      request: requestText,
      areas: snapshot.areas
    }).pipe(
      Effect.provideService(AreaRequestClassifier, AreaRequestClassifier.of(classifier)),
      Effect.mapError(
        (error) =>
          new AutoRoutingUnavailableError({
            profileId: undefined,
            message: error.message,
            cause: error
          })
      )
    );
    const validated = yield* validateAreaClassificationResult(classified, {
      version: COMPOSITIONAL_ROUTING_VERSION,
      definitionSetDigest: snapshot.definitionSetDigest,
      areas: snapshot.areas
    }).pipe(
      Effect.mapError(
        (error) =>
          new AutoRoutingUnavailableError({
            profileId: undefined,
            message: error.message,
            cause: error
          })
      )
    );

    const decision = yield* Effect.try({
      try: () =>
        routeCompositionalRequest({
          snapshot,
          decomposition: {
            version: COMPOSITIONAL_ROUTING_VERSION,
            definitionSetDigest: snapshot.definitionSetDigest,
            weights: validated.weights,
            unknownWeight: validated.unknownWeight
          },
          requirements: options.requirements,
          objective: options.objective,
          availableModels: options.availableModels,
          maximumUnknownWeight: options.maximumUnknownWeight,
          ...(options.constraints === undefined ? {} : { constraints: options.constraints })
        }),
      catch: (cause) =>
        new AutoRoutingUnavailableError({
          profileId: undefined,
          message:
            cause instanceof CompositionalRoutingError
              ? cause.message
              : "compositional automatic model routing failed",
          cause
        })
    });
    options.onDecision?.(decision, validated.classifierCallId);
    return decision.selectedModel;
  });
}

/**
 * Apply the configured auto-routing generation.
 *
 * Shadow mode deliberately preserves the v1 routing result. A v2 decision or
 * sanitized failure is observable, but cannot fail or alter the inference
 * request. Active mode fails closed through the v2 resolver and does not run
 * the legacy classifier.
 */
export function resolveConfiguredAutoRoutingModel(
  options: Readonly<{
    headers: IncomingHttpHeaders;
    model: string | undefined;
    requestText?: string;
    requirements: RequestRoutingRequirements;
    policyReader?: RoutingPolicyReader;
    classifier?: RequestClassifierService;
    servesModel(model: string): boolean;
    onDecision?(decision: AutoRoutingDecision): void;
    onCompositionalObservation?(observation: CompositionalRoutingObservation): void;
    compositionalRouting?: CompositionalRoutingRuntime;
  }>
): Effect.Effect<
  string | undefined,
  | AutoRoutingUnavailableError
  | EvalAutoRoutingForbiddenError
  | MissingRoutingProfileError
  | UnknownRoutingProfileError,
  RouteKitPlatform
> {
  const runtime = options.compositionalRouting;
  if (runtime?.mode === "active") {
    return resolveCompositionalAutoRoutingModel({
      headers: options.headers,
      model: options.model,
      requestText: options.requestText,
      requirements: options.requirements,
      policyReader: runtime.policyReader,
      classifier: runtime.classifier,
      availableModels: runtime.availableModels,
      objective: runtime.objective,
      maximumUnknownWeight: runtime.maximumUnknownWeight,
      ...(runtime.constraints === undefined ? {} : { constraints: runtime.constraints }),
      onDecision: (decision, classifierCallId) => {
        const observation: CompositionalRoutingObservation = {
          mode: "active",
          status: "decided",
          decision,
          ...(classifierCallId === undefined ? {} : { classifierCallId })
        };
        runtime.onObservation?.(observation);
        options.onCompositionalObservation?.(observation);
      }
    });
  }

  const legacy = resolveAutoRoutingModel({
    headers: options.headers,
    model: options.model,
    requestText: options.requestText,
    policyReader: options.policyReader,
    classifier: options.classifier,
    servesModel: options.servesModel,
    ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision })
  });
  if (runtime?.mode !== "shadow" || options.model?.trim().toLowerCase() !== "auto") {
    return legacy;
  }

  return legacy.pipe(
    Effect.flatMap((selectedModel) =>
      resolveCompositionalAutoRoutingModel({
        headers: options.headers,
        model: options.model,
        requestText: options.requestText,
        requirements: options.requirements,
        policyReader: runtime.policyReader,
        classifier: runtime.classifier,
        availableModels: runtime.availableModels,
        objective: runtime.objective,
        maximumUnknownWeight: runtime.maximumUnknownWeight,
        ...(runtime.constraints === undefined ? {} : { constraints: runtime.constraints }),
        onDecision: (decision, classifierCallId) => {
          const observation: CompositionalRoutingObservation = {
            mode: "shadow",
            status: "decided",
            decision,
            ...(classifierCallId === undefined ? {} : { classifierCallId })
          };
          runtime.onObservation?.(observation);
          options.onCompositionalObservation?.(observation);
        }
      }).pipe(
        Effect.as(selectedModel),
        Effect.catch((error) =>
          Effect.sync(() => {
            const observation: CompositionalRoutingObservation = {
              mode: "shadow",
              status: "failed",
              message: error.message
            };
            runtime.onObservation?.(observation);
            options.onCompositionalObservation?.(observation);
            return selectedModel;
          })
        )
      )
    )
  );
}
