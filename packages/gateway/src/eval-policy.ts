import type { IncomingHttpHeaders } from "node:http";

import {
  EVAL_POLICY_BYPASS_HEADER,
  isForbiddenEvalModel
} from "@velum-labs/routekit-eval-contracts";

export function evalPolicyBypassRequested(headers: IncomingHttpHeaders): boolean {
  const value = headers[EVAL_POLICY_BYPASS_HEADER];
  const raw = Array.isArray(value) ? value[0] : value;
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
