import { trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import { executeWebRequest } from "@velum-labs/routekit-runtime/effect";
import { Context, Effect, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import { TestdriveWorkflowError } from "./contracts.js";
import { TestdriveEvidence } from "./evidence.js";

export interface TestdriveOperatorAgentService {
  readonly answer: (input: {
    readonly profileId: string;
    readonly profileBrief: string;
    readonly question: string;
    readonly options: readonly string[];
  }) => Effect.Effect<string, TestdriveWorkflowError>;
}

export class TestdriveOperatorAgent extends Context.Service<
  TestdriveOperatorAgent,
  TestdriveOperatorAgentService
>()("@velum-labs/routekit-testkit/TestdriveOperatorAgent") {}

const assistantText = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  return typeof content === "string" && content.trim().length > 0 ? content.trim() : undefined;
};

export const makeTestdriveOperatorAgentLayer = (options: {
  readonly gatewayOrigin: string;
  readonly gatewayBearerCredential: string;
  readonly model: string;
}): Layer.Layer<TestdriveOperatorAgent, never, HttpClient.HttpClient | TestdriveEvidence> =>
  Layer.effect(
    TestdriveOperatorAgent,
    Effect.gen(function* () {
      const evidence = yield* TestdriveEvidence;
      const httpContext = yield* Effect.context<HttpClient.HttpClient>();
      const answer: TestdriveOperatorAgentService["answer"] = (input) =>
        Effect.gen(function* () {
          const response = yield* executeWebRequest(
            `${trimTrailingSlashes(options.gatewayOrigin)}/v1/chat/completions`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${options.gatewayBearerCredential}`,
                "content-type": "application/json"
              },
              body: JSON.stringify({
                model: options.model,
                messages: [
                  {
                    role: "system",
                    content: [
                      "You are the operator driving RouteKit's live eval-routing setup interview.",
                      "Answer exactly the current question using the profile brief.",
                      "Choose one listed option when it accurately advances the brief.",
                      "Return only the answer text. Never ask a question and never include credentials."
                    ].join("\n")
                  },
                  {
                    role: "user",
                    content: JSON.stringify({
                      profileId: input.profileId,
                      profileBrief: input.profileBrief,
                      question: input.question,
                      options: input.options
                    })
                  }
                ],
                max_completion_tokens: 512
              })
            }
          ).pipe(
            Effect.mapError(
              (cause) =>
                new TestdriveWorkflowError({
                  phase: "operator-agent",
                  detail: "operator agent request failed",
                  cause
                })
            )
          );
          if (!response.ok) {
            return yield* new TestdriveWorkflowError({
              phase: "operator-agent",
              detail: `operator agent failed with HTTP ${String(response.status)}`
            });
          }
          const payload = yield* Effect.promise(() =>
            response.json().then(
              (value) => ({ ok: true as const, value }),
              (cause: unknown) => ({ ok: false as const, cause })
            )
          );
          if (!payload.ok) {
            return yield* new TestdriveWorkflowError({
              phase: "operator-agent",
              detail: "operator agent response was not JSON",
              cause: payload.cause
            });
          }
          const text = assistantText(payload.value);
          if (
            text === undefined ||
            text.length > 4_096 ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
          ) {
            return yield* new TestdriveWorkflowError({
              phase: "operator-agent",
              detail: "operator agent returned missing, oversized, or invalid answer text"
            });
          }
          yield* evidence
            .emit({
              type: "profile-transition",
              phase: "operator-answer",
              profileId: input.profileId,
              model: options.model,
              status: "answered"
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TestdriveWorkflowError({
                    phase: "operator-agent",
                    detail: "failed to record operator agent event",
                    cause
                  })
              )
            );
          return text;
        }).pipe(
          Effect.provide(httpContext),
          Effect.withSpan("EvalRoutingTestdrive.operatorAgent", {
            attributes: { profileId: input.profileId, model: options.model }
          })
        );
      return TestdriveOperatorAgent.of({ answer });
    })
  );
