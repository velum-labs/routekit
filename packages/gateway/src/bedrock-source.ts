/**
 * Amazon Bedrock provider source. Discovers Anthropic foundation models and
 * inference profiles, then sends chat through Bedrock Converse. OpenAI Chat
 * Completions JSON ↔ Converse translation lives in `bedrock-codec.ts`.
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
  type ConverseCommandInput,
  ConverseStreamCommand
} from "@aws-sdk/client-bedrock-runtime";
import type { BackendRequestOptions } from "./backend.js";
import {
  errorResponse,
  fromBedrockConverseOutput,
  isOpusFiveModel,
  streamResponse,
  toBedrockConverseInput
} from "./bedrock-codec.js";
import type { DiscoveredModel, ProviderSource } from "./provider-source.js";

export type BedrockControlClient = Pick<BedrockClient, "send">;
export type BedrockRuntime = Pick<BedrockRuntimeClient, "send">;
export type BedrockProviderSourceOptions = {
  controlClient?: BedrockControlClient;
  runtimeClient?: BedrockRuntime;
};

export { fromBedrockConverseOutput, toBedrockConverseInput };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  readonly responses: ProviderSource["responses"] = { kind: "unsupported" };
  readonly capabilities: ProviderSource["capabilities"];
  readonly resource: ProviderSource["resource"];
  readonly #control: BedrockControlClient;
  readonly #runtime: BedrockRuntime;
  readonly #inferenceProfilesByFoundation = new Map<string, string>();
  constructor(options: BedrockProviderSourceOptions = {}) {
    this.#control = options.controlClient ?? new BedrockClient({});
    this.#runtime = options.runtimeClient ?? new BedrockRuntimeClient({});
    this.discovery = { discoverModels: async (signal) => await this.#discoverModels(signal) };
    this.requests = {
      chat: async (body, signal, requestOptions) => await this.#chat(body, signal, requestOptions),
      embeddings: async () =>
        Response.json(
          { error: { type: "not_implemented", message: "Bedrock embeddings are not supported" } },
          { status: 501 }
        )
    };
    this.capabilities = {
      forModel: () => ({}),
      reasoningForModel: (model) => this.#reasoningCapabilities(model)
    };
    this.resource = {
      kind: "owned",
      close: () => {
        (this.#control as { destroy?: () => void }).destroy?.();
        (this.#runtime as { destroy?: () => void }).destroy?.();
      }
    };
  }
  async #discoverModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]> {
    this.#inferenceProfilesByFoundation.clear();
    const foundation = await this.#control.send(
      new ListFoundationModelsCommand({ byProvider: "Anthropic" }),
      signal === undefined ? undefined : { abortSignal: signal }
    );
    const foundations = (foundation.modelSummaries ?? []).filter(anthropicFoundationModel);
    const byId = new Map(foundations.map((model) => [model.modelId!, model]));
    const ids = new Set(byId.keys());
    const discovered = new Map(
      foundations.map((model) => [model.modelId!, bedrockDiscoveredModel(model.modelId!, model)])
    );
    let nextToken: string | undefined;
    do {
      const profiles = await this.#control.send(
        new ListInferenceProfilesCommand({ ...(nextToken !== undefined ? { nextToken } : {}) }),
        signal === undefined ? undefined : { abortSignal: signal }
      );
      for (const profile of profiles.inferenceProfileSummaries ?? []) {
        if (!activeAnthropicProfile(profile, ids)) continue;
        const backingId = (profile.models ?? [])
          .map((model) => foundationIdFromArn(model.modelArn))
          .find((id): id is string => id !== undefined && ids.has(id));
        if (backingId !== undefined) {
          this.#inferenceProfilesByFoundation.set(
            backingId,
            preferredInferenceProfile(
              this.#inferenceProfilesByFoundation.get(backingId),
              profile.inferenceProfileId!
            )
          );
          discovered.set(
            profile.inferenceProfileId!,
            bedrockDiscoveredModel(profile.inferenceProfileId!, byId.get(backingId)!)
          );
        }
      }
      nextToken = profiles.nextToken;
    } while (nextToken !== undefined && nextToken.length > 0);
    if (discovered.size === 0)
      throw new Error("model discovery returned no active Anthropic Bedrock models");
    return [...discovered.values()];
  }
  async #chat(
    body: unknown,
    signal?: AbortSignal,
    _options?: BackendRequestOptions
  ): Promise<Response> {
    let input: ConverseCommandInput;
    try {
      input = toBedrockConverseInput(body);
    } catch (error) {
      return Response.json(
        {
          error: {
            type: "invalid_request_error",
            message: error instanceof Error ? error.message : String(error)
          }
        },
        { status: 400 }
      );
    }
    const stream = record(body)?.stream === true;
    const modelId = input.modelId;
    if (modelId === undefined) return errorResponse(new Error("Bedrock chat requires a model"));
    const runtimeModelId =
      modelId === "anthropic.claude-opus-5"
        ? (this.#inferenceProfilesByFoundation.get(modelId) ?? modelId)
        : modelId;
    const runtimeInput = runtimeModelId === modelId ? input : { ...input, modelId: runtimeModelId };
    try {
      if (stream) {
        const output = await this.#runtime.send(
          new ConverseStreamCommand(runtimeInput),
          signal === undefined ? undefined : { abortSignal: signal }
        );
        if (output.stream === undefined) throw new Error("Bedrock returned no response stream");
        return streamResponse(output.stream, modelId, signal);
      }
      const output = await this.#runtime.send(
        new ConverseCommand(runtimeInput),
        signal === undefined ? undefined : { abortSignal: signal }
      );
      return Response.json(fromBedrockConverseOutput(output, modelId));
    } catch (error) {
      return errorResponse(error);
    }
  }
  #reasoningCapabilities(model?: string): DiscoveredModel["reasoning"] {
    const known = bedrockReasoningCapabilities(model);
    if (known !== undefined) return known;
    return {
      status: "unknown",
      wireShape: "bedrock-converse",
      provenance: "provider"
    };
  }
}
