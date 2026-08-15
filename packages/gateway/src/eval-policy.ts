import type { IncomingHttpHeaders } from "node:http";

import {
  EVAL_POLICY_BYPASS_HEADER,
  isForbiddenEvalModel,
  type PublishedRoutingProfile,
  ROUTEKIT_ROUTING_PROFILE_HEADER
} from "@velum-labs/routekit-eval-contracts";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

/** Online-only projection of the published routing snapshot store. */
export type RoutingPolicyReader = Readonly<{
  getProfile(
    profileId: string
  ): Effect.Effect<PublishedRoutingProfile | undefined, Error, RouteKitPlatform>;
}>;

export class MissingRoutingProfileError extends Error {
  constructor() {
    super(`model "auto" requires the ${ROUTEKIT_ROUTING_PROFILE_HEADER} header`);
    this.name = "MissingRoutingProfileError";
  }
}

export class UnknownRoutingProfileError extends Error {
  constructor(readonly profileId: string) {
    super(`unknown routing profile: ${profileId}`);
    this.name = "UnknownRoutingProfileError";
  }
}

export class AutoRoutingUnavailableError extends Error {
  constructor(readonly profileId?: string) {
    super(
      profileId === undefined
        ? "automatic model routing is not configured"
        : `no model is available for routing profile: ${profileId}`
    );
    this.name = "AutoRoutingUnavailableError";
  }
}

function firstHeader(
  headers: IncomingHttpHeaders,
  name: string
): string | undefined {
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
export function resolveAutoRoutingModel(options: Readonly<{
  headers: IncomingHttpHeaders;
  model: string | undefined;
  policyReader?: RoutingPolicyReader;
  servesModel(model: string): boolean;
}>): Effect.Effect<string | undefined, Error, RouteKitPlatform> {
  if (options.model?.trim().toLowerCase() !== "auto") {
    return Effect.succeed(options.model);
  }
  if (evalPolicyBypassRequested(options.headers)) {
    return Effect.fail(
      new Error("eval requests must name an explicit provider/model id")
    );
  }
  const profileId = firstHeader(options.headers, ROUTEKIT_ROUTING_PROFILE_HEADER);
  if (profileId === undefined) return Effect.fail(new MissingRoutingProfileError());
  const reader = options.policyReader;
  if (reader === undefined) return Effect.fail(new AutoRoutingUnavailableError());
  return reader.getProfile(profileId).pipe(
    Effect.flatMap((profile) => {
      if (profile === undefined) return Effect.fail(new UnknownRoutingProfileError(profileId));
      const ranked = [profile.selectedModel, ...profile.fallbackModels];
      const selected = ranked.find((model, index) => {
        return ranked.indexOf(model) === index && options.servesModel(model);
      });
      return selected === undefined
        ? Effect.fail(new AutoRoutingUnavailableError(profileId))
        : Effect.succeed(selected);
    })
  );
}
