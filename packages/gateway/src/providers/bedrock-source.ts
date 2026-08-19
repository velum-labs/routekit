/**
 * Amazon Bedrock provider source. Anthropic models use Bedrock Converse;
 * allowlisted OpenAI frontier models use the regional bedrock-mantle
 * OpenAI-compatible API.
 */

import {
  BedrockClient,
  type FoundationModelSummary,
  type InferenceProfileSummary,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand
} from "@aws-sdk/client-bedrock";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand
} from "@aws-sdk/client-bedrock-runtime";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { BackendRequest, BackendRequestOptions } from "./backend.js";
import {
  errorResponse,
  fromBedrockConverseOutput,
  isOpusFiveModel,
  streamResponse,
  toBedrockConverseInput
} from "./bedrock-codec.js";
import { OpenAiBackend } from "./openai-backend.js";
import { gatewayTry, gatewayTryPromise } from "../effect/gateway.js";
import type { DiscoveredModel, ProviderSource } from "./source.js";

export type BedrockControlClient = Pick<BedrockClient, "send">;
export type BedrockRuntime = Pick<BedrockRuntimeClient, "send">;
export type BedrockMantleBackend = Pick<OpenAiBackend, "chat" | "responses">;
export type BedrockProviderSourceOptions = {
  controlClient?: BedrockControlClient;
  runtimeClient?: BedrockRuntime;
  env?: Readonly<Record<string, string | undefined>>;
  mantleBackend?: BedrockMantleBackend;
};

export { fromBedrockConverseOutput, toBedrockConverseInput };

export const BEDROCK_OPENAI_ALLOWLIST = [
  "openai.gpt-5.4",
  "openai.gpt-5.5",
  "openai.gpt-5.6-sol",
  "openai.gpt-5.6-terra",
  "openai.gpt-5.6-luna"
] as const;

const BEDROCK_OPENAI_MODEL = /^(?:(?:us|eu|global)\.)?openai\.gpt-/;

export function isBedrockOpenAiModel(modelId: string): boolean {
  return BEDROCK_OPENAI_MODEL.test(modelId);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function recognizedEncryptedPrefix(value: unknown): boolean {
  return typeof value === "string" && (value.startsWith("rsn_") || value.startsWith("smry_"));
}
function sanitizeBedrockMantleContent(content: unknown): {
  content: unknown;
  changed: boolean;
} {
  if (!Array.isArray(content)) return { content, changed: false };
  const parts = content.filter((part) => record(part)?.type !== "encrypted_content");
  return { content: parts, changed: parts.length !== content.length };
}
function sanitizeBedrockMantleInputItem(item: unknown): unknown {
  const entry = record(item);
  if (entry === undefined) return item;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (
    type === "compaction" &&
    "encrypted_content" in entry &&
    !recognizedEncryptedPrefix(entry.encrypted_content)
  ) {
    return undefined;
  }
  if (type === "agent_message") {
    const { content } = sanitizeBedrockMantleContent(entry.content);
    return { type: "message", role: "user", content };
  }
  let next = entry;
  let changed = false;
  if (Array.isArray(entry.content)) {
    const sanitized = sanitizeBedrockMantleContent(entry.content);
    if (sanitized.changed) {
      next = { ...next, content: sanitized.content };
      changed = true;
    }
  }
  if (
    type === "reasoning" &&
    "encrypted_content" in next &&
    !recognizedEncryptedPrefix(next.encrypted_content)
  ) {
    const { encrypted_content: _ignored, ...rest } = next;
    next = rest;
    changed = true;
  }
  return changed ? next : item;
}
/**
 * Remove OpenAI/Codex protocol fields that bedrock-mantle rejects while
 * leaving native OpenAI egress unchanged.
 */
export function sanitizeBedrockMantleRequestBody(body: unknown): unknown {
  const payload = record(body);
  if (payload === undefined) return body;
  let next: Record<string, unknown> = payload;
  let changed = false;
  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.map((tool) => {
      const entry = record(tool);
      if (entry === undefined) return tool;
      const type = typeof entry.type === "string" ? entry.type : "";
      if (!type.startsWith("web_search") || !("search_content_types" in entry)) return tool;
      changed = true;
      const { search_content_types: _ignored, ...rest } = entry;
      return rest;
    });
    if (changed) next = { ...next, tools };
  }
  if (Array.isArray(payload.input)) {
    const input: unknown[] = [];
    let inputChanged = false;
    for (const item of payload.input) {
      const sanitized = sanitizeBedrockMantleInputItem(item);
      if (sanitized === undefined) {
        inputChanged = true;
        continue;
      }
      if (sanitized !== item) inputChanged = true;
      input.push(sanitized);
    }
    if (inputChanged) {
      changed = true;
      next = { ...next, input };
    }
  }
  return changed ? next : body;
}
function mantleApiKey(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const key = env.AWS_BEARER_TOKEN_BEDROCK ?? env.BEDROCK_API_KEY;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}
function mantleRegion(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  return typeof region === "string" && region.length > 0 ? region : undefined;
}
function mantleBaseUrl(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}
function bedrockOpenAiNativeId(modelId: string): string {
  return modelId.replace(/^(?:us|eu|global)\./, "");
}
function bedrockOpenAiReasoning(modelId: string): DiscoveredModel["reasoning"] {
  const native = bedrockOpenAiNativeId(modelId).replace(/^openai\./, "");
  if (/^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(native)) {
    return {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      defaultEffort: "medium",
      wireShape: "openai-responses",
      provenance: "builtin"
    };
  }
  if (/^gpt-5\.(?:4|5)(?:-\d{4}-\d{2}-\d{2})?$/.test(native)) {
    return {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh"].map((id) => ({ id })),
      wireShape: "openai-responses",
      provenance: "builtin"
    };
  }
  return {
    status: "supported",
    wireShape: "openai-responses",
    provenance: "builtin"
  };
}
function bedrockOpenAiDiscoveredModel(id: string): DiscoveredModel {
  return {
    id,
    metadata: {
      architecture: {
        modality: "text+image->text",
        inputModalities: ["text", "image"],
        outputModalities: ["text"]
      },
      supportedParameters: ["tools", "tool_choice"],
      provenance: "route"
    },
    reasoning: bedrockOpenAiReasoning(id),
    capabilities: { streaming: "supported" }
  };
}
function anthropicFoundationModel(model: FoundationModelSummary): boolean {
  return (
    model.providerName?.toLowerCase() === "anthropic" &&
    model.modelLifecycle?.status === "ACTIVE" &&
    typeof model.modelId === "string" &&
    model.modelId.length > 0
  );
}
function foundationIdFromArn(arn: string | undefined): string | undefined {
  if (arn === undefined) return undefined;
  const marker = ":foundation-model/";
  const index = arn.indexOf(marker);
  return index < 0 ? undefined : arn.slice(index + marker.length);
}
function activeAnthropicProfile(
  profile: InferenceProfileSummary,
  anthropicModels: ReadonlySet<string>
): boolean {
  return (
    profile.status === "ACTIVE" &&
    typeof profile.inferenceProfileId === "string" &&
    profile.inferenceProfileId.length > 0 &&
    (profile.models ?? []).some((model) => {
      const id = foundationIdFromArn(model.modelArn);
      return id !== undefined && anthropicModels.has(id);
    })
  );
}
function inferenceProfilePriority(profileId: string): number {
  if (profileId.startsWith("us.")) return 0;
  if (profileId.startsWith("global.")) return 1;
  return 2;
}
function preferredInferenceProfile(current: string | undefined, candidate: string): string {
  if (current === undefined) return candidate;
  return inferenceProfilePriority(candidate) < inferenceProfilePriority(current)
    ? candidate
    : current;
}
function bedrockReasoningCapabilities(modelId: string | undefined): DiscoveredModel["reasoning"] {
  if (modelId === undefined || !isOpusFiveModel(modelId)) return undefined;
  return {
    status: "supported",
    efforts: ["low", "medium", "high", "max"].map((id) => ({ id })),
    adaptive: true,
    wireShape: "bedrock-converse",
    provenance: "builtin"
  };
}
function bedrockMetadata(model: FoundationModelSummary): DiscoveredModel["metadata"] {
  const inputModalities = (model.inputModalities ?? []).map((value) => value.toLowerCase());
  const outputModalities = (model.outputModalities ?? []).map((value) => value.toLowerCase());
  const inputs = inputModalities.length > 0 ? inputModalities : ["text"];
  const outputs = outputModalities.length > 0 ? outputModalities : ["text"];
  return {
    architecture: {
      modality: `${inputs.join("+")}->${outputs.join("+")}`,
      inputModalities: inputs,
      outputModalities: outputs
    },
    supportedParameters: ["tools", "tool_choice"],
    provenance: inputModalities.length > 0 || outputModalities.length > 0 ? "provider" : "route"
  };
}
function bedrockDiscoveredModel(id: string, model: FoundationModelSummary): DiscoveredModel {
  const reasoning = bedrockReasoningCapabilities(model.modelId);
  return {
    id,
    metadata: bedrockMetadata(model),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(model.responseStreamingSupported !== undefined
      ? {
          capabilities: {
            streaming: model.responseStreamingSupported ? "supported" : "unsupported"
          }
        }
      : {})
  };
}

export class BedrockProviderSource implements ProviderSource {
  readonly sourceId = "bedrock" as const;
  readonly discovery: ProviderSource["discovery"];
  readonly requests: ProviderSource["requests"];
  readonly responses: ProviderSource["responses"];
  readonly capabilities: ProviderSource["capabilities"];
  readonly resource: ProviderSource["resource"];
  readonly #control: BedrockControlClient;
  readonly #runtime: BedrockRuntime;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #injectedMantle: BedrockMantleBackend | undefined;
  #mantle: BedrockMantleBackend | undefined;
  readonly #inferenceProfilesByFoundation = new Map<string, string>();
  constructor(options: BedrockProviderSourceOptions = {}) {
    this.#control = options.controlClient ?? new BedrockClient({});
    this.#runtime = options.runtimeClient ?? new BedrockRuntimeClient({});
    this.#env = options.env ?? process.env;
    this.#injectedMantle = options.mantleBackend;
    this.discovery = { discoverModels: (signal) => this.#discoverModels(signal) };
    this.requests = {
      chat: (body, signal, requestOptions) => this.#chat(body, signal, requestOptions),
      embeddings: () =>
        Effect.succeed(
          Response.json(
            { error: { type: "not_implemented", message: "Bedrock embeddings are not supported" } },
            { status: 501 }
          )
        )
    };
    this.responses = {
      kind: "responses",
      supports: (model) => isBedrockOpenAiModel(model),
      execute: (body, signal, requestOptions) => this.#responses(body, signal, requestOptions)
    };
    this.capabilities = {
      forModel: () => ({}),
      reasoningForModel: (model) => this.#reasoningCapabilities(model)
    };
    this.resource = {
      kind: "owned",
      close: Effect.sync(() => {
        (this.#control as { destroy?: () => void }).destroy?.();
        (this.#runtime as { destroy?: () => void }).destroy?.();
      })
    };
  }
  #mantleBackend(): BedrockMantleBackend | undefined {
    if (this.#injectedMantle !== undefined) return this.#injectedMantle;
    if (this.#mantle !== undefined) return this.#mantle;
    const apiKey = mantleApiKey(this.#env);
    const region = mantleRegion(this.#env);
    if (apiKey === undefined || region === undefined) return undefined;
    this.#mantle = new OpenAiBackend({
      baseUrl: mantleBaseUrl(region),
      apiKey
    });
    return this.#mantle;
  }
  #missingMantleResponse(): Response {
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: "Bedrock OpenAI models require AWS_BEARER_TOKEN_BEDROCK and AWS_REGION"
        }
      },
      { status: 400 }
    );
  }
  #discoverModels(signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      self.#inferenceProfilesByFoundation.clear();
      const abort = signal === undefined ? undefined : { abortSignal: signal };
      const discovered = yield* Effect.gen(function* () {
        const foundation = yield* gatewayTryPromise(() =>
          self.#control.send(new ListFoundationModelsCommand({ byProvider: "Anthropic" }), abort)
        );
        const foundations = (foundation.modelSummaries ?? []).filter(anthropicFoundationModel);
        const byId = new Map(foundations.map((model) => [model.modelId!, model]));
        const ids = new Set(byId.keys());
        const anthropic = new Map(
          foundations.map((model) => [
            model.modelId!,
            bedrockDiscoveredModel(model.modelId!, model)
          ])
        );
        let nextToken: string | undefined;
        do {
          const profiles = yield* gatewayTryPromise(() =>
            self.#control.send(
              new ListInferenceProfilesCommand({
                ...(nextToken !== undefined ? { nextToken } : {})
              }),
              abort
            )
          );
          for (const profile of profiles.inferenceProfileSummaries ?? []) {
            if (!activeAnthropicProfile(profile, ids)) continue;
            const backingId = (profile.models ?? [])
              .map((model) => foundationIdFromArn(model.modelArn))
              .find((id): id is string => id !== undefined && ids.has(id));
            if (backingId !== undefined) {
              self.#inferenceProfilesByFoundation.set(
                backingId,
                preferredInferenceProfile(
                  self.#inferenceProfilesByFoundation.get(backingId),
                  profile.inferenceProfileId!
                )
              );
              anthropic.set(
                profile.inferenceProfileId!,
                bedrockDiscoveredModel(profile.inferenceProfileId!, byId.get(backingId)!)
              );
            }
          }
          nextToken = profiles.nextToken;
        } while (nextToken !== undefined && nextToken.length > 0);
        return anthropic;
      }).pipe(
        Effect.catch((error) => {
          if (mantleApiKey(self.#env) === undefined) return Effect.fail(error);
          self.#inferenceProfilesByFoundation.clear();
          return Effect.succeed(new Map<string, DiscoveredModel>());
        })
      );
      if (mantleApiKey(self.#env) !== undefined) {
        for (const id of BEDROCK_OPENAI_ALLOWLIST) {
          discovered.set(id, bedrockOpenAiDiscoveredModel(id));
        }
      }
      if (discovered.size === 0) {
        return yield* new RouteKitFailure({
          message: "model discovery returned no active Anthropic Bedrock models"
        });
      }
      return [...discovered.values()];
    });
  }
  #responses(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest {
    const requestedModel = record(body)?.model;
    const model = typeof requestedModel === "string" ? requestedModel : "";
    if (!isBedrockOpenAiModel(model)) {
      return Effect.succeed(
        Response.json(
          { error: { type: "not_supported", message: "native Responses egress is not supported" } },
          { status: 501 }
        )
      );
    }
    const backend = this.#mantleBackend();
    if (backend === undefined) return Effect.succeed(this.#missingMantleResponse());
    return backend.responses(sanitizeBedrockMantleRequestBody(body), signal, options);
  }
  #chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest {
    const self = this;
    return Effect.gen(function* () {
      const requestedModel = record(body)?.model;
      if (typeof requestedModel === "string" && isBedrockOpenAiModel(requestedModel)) {
        const backend = self.#mantleBackend();
        if (backend === undefined) return self.#missingMantleResponse();
        return yield* backend.chat(sanitizeBedrockMantleRequestBody(body), signal, options);
      }
      const input = yield* gatewayTry(() => toBedrockConverseInput(body)).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            Response.json(
              {
                error: {
                  type: "invalid_request_error",
                  message: error instanceof Error ? error.message : String(error)
                }
              },
              { status: 400 }
            )
          )
        )
      );
      if (input instanceof Response) return input;
      const stream = record(body)?.stream === true;
      const modelId = input.modelId;
      if (modelId === undefined) return errorResponse("Bedrock chat requires a model");
      const runtimeModelId =
        modelId === "anthropic.claude-opus-5"
          ? (self.#inferenceProfilesByFoundation.get(modelId) ?? modelId)
          : modelId;
      const runtimeInput =
        runtimeModelId === modelId ? input : { ...input, modelId: runtimeModelId };
      const abort = signal === undefined ? undefined : { abortSignal: signal };
      if (stream) {
        const output = yield* gatewayTryPromise(() =>
          self.#runtime.send(new ConverseStreamCommand(runtimeInput), abort)
        ).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))));
        if (output instanceof Response) return output;
        if (output.stream === undefined)
          return errorResponse("Bedrock returned no response stream");
        return streamResponse(output.stream, modelId, signal);
      }
      const output = yield* gatewayTryPromise(() =>
        self.#runtime.send(new ConverseCommand(runtimeInput), abort)
      ).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))));
      if (output instanceof Response) return output;
      return Response.json(fromBedrockConverseOutput(output, modelId));
    });
  }
  #reasoningCapabilities(model?: string): DiscoveredModel["reasoning"] {
    if (model !== undefined && isBedrockOpenAiModel(model)) {
      return bedrockOpenAiReasoning(model);
    }
    const known = bedrockReasoningCapabilities(model);
    if (known !== undefined) return known;
    return {
      status: "unknown",
      wireShape: "bedrock-converse",
      provenance: "provider"
    };
  }
}
