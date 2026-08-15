import { Clock, Context, Data, Effect, Layer, Redacted, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { EvalGatewayConfig } from "./config.js";
import { validateExplicitEvalModel } from "./config.js";

export type EvalRunRole = "candidate" | "judge" | "author";
export interface EvalHarnessRequest {
  readonly role: EvalRunRole;
  readonly model: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly outputSchema?: unknown;
  readonly timeoutMs?: number;
}
export interface EvalHarnessUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}
export interface EvalHarnessResult {
  readonly model: string;
  readonly role: EvalRunRole;
  readonly text: string;
  readonly durationMs: number;
  readonly toolCalls: readonly string[];
  readonly usage?: EvalHarnessUsage;
  readonly raw: unknown;
}
export class EvalHarnessError extends Data.TaggedError("EvalHarnessError")<{
  readonly role: EvalRunRole;
  readonly model: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `RouteKit Eval ${this.role} call failed${this.status === undefined ? "" : ` (${this.status})`}.`;
  }
}
export interface EvalHarnessService {
  readonly invoke: (
    request: EvalHarnessRequest
  ) => Effect.Effect<EvalHarnessResult, EvalHarnessError>;
  readonly stream: (
    request: EvalHarnessRequest
  ) => Stream.Stream<EvalHarnessResult, EvalHarnessError>;
}
export class EvalHarness extends Context.Service<EvalHarness, EvalHarnessService>()(
  "@velum-labs/routekit-eval-engine/EvalHarness"
) {}

const completionText = (payload: unknown): string => {
  if (typeof payload !== "object" || payload === null) return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices[0] === undefined) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content : "";
};
const toolNames = (payload: unknown): readonly string[] => {
  if (typeof payload !== "object" || payload === null) return [];
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices[0] === undefined) return [];
  const calls = (choices[0] as { message?: { tool_calls?: unknown } }).message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => {
    if (typeof call !== "object" || call === null) return [];
    const name = (call as { function?: { name?: unknown } }).function?.name;
    return typeof name === "string" ? [name] : [];
  });
};
const usageFrom = (payload: unknown): EvalHarnessUsage | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const value = usage as Record<string, unknown>;
  const decoded = {
    inputTokens: typeof value.prompt_tokens === "number" ? value.prompt_tokens : undefined,
    outputTokens: typeof value.completion_tokens === "number" ? value.completion_tokens : undefined,
    costUsd: typeof value.cost === "number" ? value.cost : undefined
  };
  return Object.values(decoded).every((entry) => entry === undefined) ? undefined : decoded;
};

export const makeEvalHarnessLayer = (
  config: EvalGatewayConfig
): Layer.Layer<EvalHarness, never, HttpClient.HttpClient> =>
  Layer.effect(
    EvalHarness,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const invoke = (input: EvalHarnessRequest) =>
        Effect.gen(function* () {
          const invalid = validateExplicitEvalModel(input.model, input.role);
          if (invalid !== undefined)
            return yield* new EvalHarnessError({
              role: input.role,
              model: input.model,
              cause: invalid
            });
          const started = yield* Clock.currentTimeMillis;
          const body = {
            model: input.model,
            messages: [
              ...(input.systemPrompt === undefined
                ? []
                : [{ role: "system", content: input.systemPrompt }]),
              { role: "user", content: input.prompt }
            ],
            stream: false,
            ...(input.reasoningEffort === undefined
              ? {}
              : { reasoning_effort: input.reasoningEffort }),
            ...(input.outputSchema === undefined
              ? {}
              : { response_format: { type: "json_schema", json_schema: input.outputSchema } })
          };
          const request = HttpClientRequest.post(
            `${config.inferenceOrigin.replace(/\/$/u, "")}/v1/chat/completions`
          ).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${Redacted.value(config.credential)}`,
              "content-type": "application/json",
              "x-routekit-eval-role": input.role,
              "x-routekit-eval-policy-bypass": "1"
            }),
            HttpClientRequest.bodyText(JSON.stringify(body))
          );
          const response = yield* client
            .execute(request)
            .pipe(
              Effect.mapError(
                (cause) => new EvalHarnessError({ role: input.role, model: input.model, cause })
              )
            );
          if (response.status < 200 || response.status >= 300) {
            return yield* new EvalHarnessError({
              role: input.role,
              model: input.model,
              status: response.status
            });
          }
          const payload = yield* response.json.pipe(
            Effect.mapError(
              (cause) => new EvalHarnessError({ role: input.role, model: input.model, cause })
            )
          );
          const usage = usageFrom(payload);
          return {
            model: input.model,
            role: input.role,
            text: completionText(payload),
            durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - started),
            toolCalls: toolNames(payload),
            ...(usage === undefined ? {} : { usage }),
            raw: payload
          } satisfies EvalHarnessResult;
        });
      return EvalHarness.of({ invoke, stream: (request) => Stream.fromEffect(invoke(request)) });
    })
  );
