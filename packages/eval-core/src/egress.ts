import {
  assertExplicitEvalModel,
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY_BYPASS_HEADER,
  type EvalAttribution,
  type EvalRole
} from "@velum-labs/routekit-eval-contracts";
import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

export type EvalEgressOptions = {
  gatewayUrl: string;
  token: string;
};

function completionText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices[0] === undefined) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content : "";
}

export function completeEvalChat(input: {
  egress: EvalEgressOptions;
  model: string;
  role: EvalRole;
  runId: string;
  caseId: string;
  prompt: string;
}): Effect.Effect<string, Error> {
  assertExplicitEvalModel(input.model, input.role);
  const attribution: EvalAttribution = {
    purpose: "eval",
    role: input.role,
    runId: input.runId,
    caseId: input.caseId
  };
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${input.egress.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.egress.token}`,
          "content-type": "application/json",
          [EVAL_POLICY_BYPASS_HEADER]: "1",
          [EVAL_ATTRIBUTION_HEADER]: JSON.stringify(attribution)
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: input.prompt }],
          stream: false
        })
      });
      if (!response.ok) {
        throw new Error(`${input.role} call failed (${response.status})`);
      }
      return completionText(await response.json());
    },
    catch: (cause) => routeKitError(cause)
  });
}
