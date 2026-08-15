import type { IncomingHttpHeaders } from "node:http";

import {
  EVAL_POLICY_BYPASS_HEADER,
  isForbiddenEvalModel,
  type PublishedRoutingProfile,
  ROUTEKIT_ROUTING_PROFILE_HEADER
} from "@velum-labs/routekit-eval-contracts";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Data, Effect } from "effect";

export class RoutingPolicyReadError extends Data.TaggedError("RoutingPolicyReadError")<{
  readonly profileId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Online-only projection of the published routing snapshot store. */
export type RoutingPolicyReader = Readonly<{
  getProfile(
    profileId: string
  ): Effect.Effect<PublishedRoutingProfile | undefined, RoutingPolicyReadError, RouteKitPlatform>;
}>;

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
}> {}

export class EvalAutoRoutingForbiddenError extends Data.TaggedError(
  "EvalAutoRoutingForbiddenError"
)<{
  readonly message: string;
}> {}

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

/**
 * Resolve `model: "auto"` from a published profile. Explicit model requests
 * are returned untouched and never require the online policy reader.
 */
export function resolveAutoRoutingModel(
  options: Readonly<{
    headers: IncomingHttpHeaders;
    model: string | undefined;
    policyReader?: RoutingPolicyReader;
    servesModel(model: string): boolean;
  }>
): Effect.Effect<
  string | undefined,
  | AutoRoutingUnavailableError
  | EvalAutoRoutingForbiddenError
  | MissingRoutingProfileError
  | RoutingPolicyReadError
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
  const profileId = firstHeader(options.headers, ROUTEKIT_ROUTING_PROFILE_HEADER);
  if (profileId === undefined) {
    return Effect.fail(
      new MissingRoutingProfileError({
        message: `model "auto" requires the ${ROUTEKIT_ROUTING_PROFILE_HEADER} header`
      })
    );
  }
  const reader = options.policyReader;
  if (reader === undefined) {
    return Effect.fail(
      new AutoRoutingUnavailableError({
        profileId: undefined,
        message: "automatic model routing is not configured"
      })
    );
  }
  return Effect.gen(function* () {
    const profile = yield* reader.getProfile(profileId);
    if (profile === undefined) {
      return yield* new UnknownRoutingProfileError({
        profileId,
        message: `unknown routing profile: ${profileId}`
      });
    }
    const ranked = [profile.selectedModel, ...profile.fallbackModels];
    const selected = ranked.find((model, index) => {
      return ranked.indexOf(model) === index && options.servesModel(model);
    });
    if (selected === undefined) {
      return yield* new AutoRoutingUnavailableError({
        profileId,
        message: `no model is available for routing profile: ${profileId}`
      });
    }
    return selected;
  });
}
