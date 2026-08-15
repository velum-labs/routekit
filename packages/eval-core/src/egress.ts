import {
  assertExplicitEvalModel,
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY_BYPASS_HEADER,
  type EvalRole
} from "@velum-labs/routekit-eval-contracts";
import { RouteKitFailure, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

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
}): Effect.Effect<string, Error, HttpClient.HttpClient> {
  const url = `${input.egress.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const request = HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders({
      authorization: `Bearer ${input.egress.token}`,
      "content-type": "application/json",
      [EVAL_POLICY_BYPASS_HEADER]: "1",
      [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
        purpose: "eval",
        role: input.role,
        runId: input.runId,
        caseId: input.caseId
      })
    }),
    HttpClientRequest.bodyText(
      JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }],
        stream: false
      })
    )
  );
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => assertExplicitEvalModel(input.model, input.role),
      catch: (cause) => toRouteKitFailure(cause)
    });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new RouteKitFailure({
        message: `${input.role} call failed (${response.status})`
      });
    }
    const payload = yield* response.json;
    return completionText(payload);
  });
}
