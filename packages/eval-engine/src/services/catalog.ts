import { Context, Data, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { EvalGatewayConfig } from "./config.js";

export interface EvalCatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly contextLength?: number;
  readonly inputPrice?: number;
  readonly outputPrice?: number;
  readonly supportedParameters?: readonly string[];
}

export class EvalCatalogError extends Data.TaggedError("EvalCatalogError")<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly status?: number;
}> {
  override get message(): string {
    return `RouteKit Eval catalog ${this.operation} failed${this.status === undefined ? "" : ` (${this.status})`}.`;
  }
}

export interface EvalCatalogService {
  readonly list: Effect.Effect<readonly EvalCatalogModel[], EvalCatalogError>;
  readonly get: (model: string) => Effect.Effect<EvalCatalogModel | undefined, EvalCatalogError>;
}

export class EvalCatalog extends Context.Service<EvalCatalog, EvalCatalogService>()(
  "@velum-labs/routekit-eval-engine/EvalCatalog"
) {}

const decodeModels = (payload: unknown): readonly EvalCatalogModel[] => {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string") return [];
    return [
      {
        id: value.id,
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.context_length === "number"
          ? { contextLength: value.context_length }
          : {}),
        ...(Array.isArray(value.supported_parameters)
          ? {
              supportedParameters: value.supported_parameters.filter(
                (item): item is string => typeof item === "string"
              )
            }
          : {})
      }
    ];
  });
};

export const makeEvalCatalogLayer = (
  config: EvalGatewayConfig
): Layer.Layer<EvalCatalog, never, HttpClient.HttpClient> =>
  Layer.effect(
    EvalCatalog,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const list = Effect.gen(function* () {
        const request = HttpClientRequest.get(
          `${config.catalogOrigin.replace(/\/$/u, "")}/v1/models`
        ).pipe(
          HttpClientRequest.setHeader(
            "authorization",
            `Bearer ${Redacted.value(config.credential)}`
          )
        );
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError((cause) => new EvalCatalogError({ operation: "request", cause })));
        if (response.status < 200 || response.status >= 300) {
          return yield* new EvalCatalogError({ operation: "request", status: response.status });
        }
        const payload = yield* response.json.pipe(
          Effect.mapError((cause) => new EvalCatalogError({ operation: "decode", cause }))
        );
        return decodeModels(payload);
      });
      return EvalCatalog.of({
        list,
        get: (model) =>
          list.pipe(Effect.map((models) => models.find((entry) => entry.id === model)))
      });
    })
  );
