import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  JsonValue,
  ModelCallContract,
  ModelChatMessage,
  ModelUsage,
  ProviderError,
  RequestAttribution
} from "@velum-labs/routekit-contracts";
import { artifactHash, requestHash, responseHash } from "@velum-labs/routekit-contracts";

import { meterCall, parseUsage, parseUsageFromSse } from "./cost.js";
import { decodeBufferedSse } from "../sse/parse.js";

export type GatewayDialect =
  | "openai-chat"
  | "openai-embeddings"
  | "anthropic-messages"
  | "openai-responses";

export const MODEL_CALL_ID_HEADER = "x-routekit-model-call-id";
export const UNKNOWN_GIT_SHA = "unknown";

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const GIT_REF_PREFIX = "ref: ";

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function resolveProducerGitSha(fromDir: string = moduleDir()): string {
  const stamped = process.env.ROUTEKIT_BUILD_GIT_SHA?.trim();
  if (stamped !== undefined && GIT_SHA_PATTERN.test(stamped)) return stamped;
  if (fromDir.includes("node_modules")) return UNKNOWN_GIT_SHA;
  let directory = fromDir;
  for (let depth = 0; depth < 16; depth += 1) {
    const gitDirectory = resolveGitDirectory(directory);
    if (gitDirectory !== undefined) {
      return readGitHead(gitDirectory) ?? UNKNOWN_GIT_SHA;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return UNKNOWN_GIT_SHA;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function resolveGitDirectory(repositoryRoot: string): string | undefined {
  const marker = join(repositoryRoot, ".git");
  if (readText(join(marker, "HEAD")) !== undefined) return marker;
  const pointer = readText(marker);
  if (pointer === undefined || !pointer.startsWith("gitdir:")) return undefined;
  const target = pointer.slice("gitdir:".length).trim();
  return isAbsolute(target) ? target : resolve(repositoryRoot, target);
}

function readGitHead(gitDirectory: string): string | undefined {
  const head = readText(join(gitDirectory, "HEAD"));
  if (head === undefined) return undefined;
  if (GIT_SHA_PATTERN.test(head)) return head;
  if (!head.startsWith(GIT_REF_PREFIX)) return undefined;
  const reference = head.slice(GIT_REF_PREFIX.length).trim();
  const commonDirectory = readText(join(gitDirectory, "commondir"));
  const roots = [
    gitDirectory,
    ...(commonDirectory === undefined ? [] : [resolve(gitDirectory, commonDirectory)])
  ];
  for (const root of roots) {
    const loose = readText(join(root, reference));
    if (loose !== undefined && GIT_SHA_PATTERN.test(loose)) return loose;
    const packed = readText(join(root, "packed-refs"));
    if (packed === undefined) continue;
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, name] = line.trim().split(/\s+/u);
      if (name === reference && sha !== undefined && GIT_SHA_PATTERN.test(sha)) return sha;
    }
  }
  return undefined;
}

export function readProducerVersion(fromDir: string = moduleDir(), fallback = "0.0.0"): string {
  let dir = fromDir;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

export type ModelGatewayCallContext = {
  callId: string;
  dialect: GatewayDialect;
  requestedModel: string | undefined;
  model: string | undefined;
  stream: boolean;
  requestBody: unknown;
  startedAt: string;
  endpointId?: string;
  attribution?: RequestAttribution;
};

export type ModelGatewayCallResult = {
  statusCode: number;
  responseBody?: Buffer;
  durationMs: number;
  error?: unknown;
};

export type ModelCallRecord = ModelCallContract;

export type ProvenanceSink = {
  onModelCall?(record: ModelCallRecord): void;
  onModelCallRaw?(context: ModelGatewayCallContext, result: ModelGatewayCallResult): void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(buffer: Buffer | undefined): unknown {
  if (buffer === undefined || buffer.length === 0) return undefined;
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function responseText(buffer: Buffer | undefined): string {
  return buffer?.toString("utf8") ?? "";
}

function requestMessages(body: unknown): ModelChatMessage[] {
  const messages = asRecord(body)?.messages;
  if (!Array.isArray(messages)) return [{ role: "user", content: requestHash(body) }];
  const projected = messages.flatMap((message): ModelChatMessage[] => {
    const item = asRecord(message);
    const role = item?.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return [];
    return [{ role, content: requestHash(item?.content ?? "") }];
  });
  return projected.length > 0 ? projected : [{ role: "user", content: requestHash(body) }];
}

function usageFromResponse(body: Buffer | undefined): ModelUsage | undefined {
  const parsed = asRecord(parseJson(body));
  const usage = parseUsage(parsed?.usage) ?? parseUsageFromSse(responseText(body));
  if (usage === undefined) return undefined;
  return {
    ...(usage.promptTokens !== undefined ? { prompt_tokens: usage.promptTokens } : {}),
    ...(usage.completionTokens !== undefined ? { completion_tokens: usage.completionTokens } : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {})
  };
}

function providerRequestId(body: Buffer | undefined): string | undefined {
  const id = asRecord(parseJson(body))?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function streamedProviderError(body: Buffer | undefined): Record<string, unknown> | undefined {
  const text = responseText(body);
  if (!text.includes("response.failed") && !text.includes("response.incomplete")) return undefined;
  for (const event of decodeBufferedSse(text)) {
    let payload: Record<string, unknown> | undefined;
    try {
      payload = asRecord(JSON.parse(event.data));
    } catch {
      continue;
    }
    const eventType = event.event ?? payload?.type;
    if (
      eventType !== "response.failed" &&
      eventType !== "response.incomplete" &&
      eventType !== "error"
    ) {
      continue;
    }
    const response = asRecord(payload?.response);
    return (
      asRecord(payload?.error) ??
      asRecord(response?.error) ??
      asRecord(response?.incomplete_details)
    );
  }
  return undefined;
}

function providerError(result: ModelGatewayCallResult): ProviderError | undefined {
  const streamError = streamedProviderError(result.responseBody);
  if (
    result.error === undefined &&
    result.statusCode >= 200 &&
    result.statusCode < 400 &&
    streamError === undefined
  ) {
    return undefined;
  }
  const responseError = asRecord(asRecord(parseJson(result.responseBody))?.error) ?? streamError;
  const noModelAvailable =
    result.statusCode === 503 &&
    responseError?.type === "unavailable" &&
    responseError.message === "no model is available; configure a provider";
  const streamErrorIdentity =
    `${responseError?.type ?? ""} ${responseError?.error_type ?? ""} ${responseError?.code ?? ""}`.toLowerCase();
  const streamRateLimited = /usage[_ ]?limit|rate[_ ]?limit|quota|insufficient_quota/.test(
    streamErrorIdentity
  );
  const kind = noModelAvailable
    ? "capability_missing"
    : streamRateLimited
      ? "rate_limited"
      : result.statusCode === 408
        ? "timeout"
        : result.statusCode === 429
          ? "rate_limited"
          : result.statusCode === 400 || result.statusCode === 422
            ? "validation_error"
            : "provider_error";
  const message =
    kind === "capability_missing"
      ? "no model route is configured"
      : kind === "timeout"
        ? "provider request timed out"
        : kind === "rate_limited"
          ? "provider rate limited the request"
          : kind === "validation_error"
            ? "provider rejected the request"
            : "provider request failed";
  return {
    kind,
    message,
    retryable:
      !noModelAvailable &&
      (streamRateLimited ||
        result.statusCode === 408 ||
        result.statusCode === 429 ||
        result.statusCode >= 500)
  };
}

export function buildModelCallRecord(
  context: ModelGatewayCallContext,
  result: ModelGatewayCallResult
): ModelCallRecord {
  const usage = usageFromResponse(result.responseBody);
  const callCost = meterCall({
    model: context.model ?? context.requestedModel ?? "unknown",
    usage:
      usage === undefined
        ? undefined
        : {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens
          }
  });
  const error = providerError(result);
  const metadata: Record<string, JsonValue> = {
    dialect: context.dialect,
    stream: context.stream,
    http_status: result.statusCode,
    duration_ms: result.durationMs,
    requested_model: context.requestedModel ?? null,
    unknown_usage: callCost.unknownUsage,
    unknown_cost: callCost.unknownCost,
    ...(context.attribution !== undefined
      ? {
          attribution: {
            effective_model: context.attribution.effective_model,
            ...(context.attribution.native_model !== undefined
              ? { native_model: context.attribution.native_model }
              : {}),
            provider: context.attribution.provider,
            billing_mode: context.attribution.billing_mode,
            ...(context.attribution.account !== undefined
              ? { account: { seat: context.attribution.account.seat } }
              : {}),
            ...(context.attribution.principal !== undefined
              ? {
                  principal: {
                    token_id: context.attribution.principal.token_id,
                    ...(context.attribution.principal.label !== undefined
                      ? { label: context.attribution.principal.label }
                      : {})
                  }
                }
              : {}),
            ...(context.attribution.compositional_routing !== undefined
              ? {
                  compositional_routing: {
                    version: 2,
                    basis_digest:
                      context.attribution.compositional_routing.basis_digest,
                    evidence_digest: context.attribution.compositional_routing.evidence_digest,
                    weights: context.attribution.compositional_routing.weights.map((entry) => ({
                      dimension_id: entry.dimension_id,
                      weight: entry.weight
                    })),
                    unknown_weight: context.attribution.compositional_routing.unknown_weight,
                    requirements: {
                      endpoint: context.attribution.compositional_routing.requirements.endpoint,
                      requires_tools:
                        context.attribution.compositional_routing.requirements.requires_tools,
                      requires_vision:
                        context.attribution.compositional_routing.requirements.requires_vision,
                      ...(context.attribution.compositional_routing.requirements.input_tokens ===
                      undefined
                        ? {}
                        : {
                            input_tokens:
                              context.attribution.compositional_routing.requirements.input_tokens
                          }),
                      ...(context.attribution.compositional_routing.requirements
                        .max_output_tokens === undefined
                        ? {}
                        : {
                            max_output_tokens:
                              context.attribution.compositional_routing.requirements
                                .max_output_tokens
                          })
                    },
                    objective: context.attribution.compositional_routing.objective,
                    candidates: context.attribution.compositional_routing.candidates.map(
                      (candidate) => ({
                        model: candidate.model,
                        eligible: candidate.eligible,
                        exclusion_reasons: [...candidate.exclusion_reasons],
                        ...(candidate.quality === undefined ? {} : { quality: candidate.quality }),
                        ...(candidate.failure_rate === undefined
                          ? {}
                          : { failure_rate: candidate.failure_rate }),
                        ...(candidate.p95_duration_ms === undefined
                          ? {}
                          : { p95_duration_ms: candidate.p95_duration_ms }),
                        ...(candidate.average_cost_usd === undefined
                          ? {}
                          : { average_cost_usd: candidate.average_cost_usd }),
                        cost_status: candidate.cost_status,
                        ...(candidate.utility === undefined ? {} : { utility: candidate.utility }),
                        ...(candidate.rank === undefined ? {} : { rank: candidate.rank })
                      })
                    ),
                    selected_model: context.attribution.compositional_routing.selected_model,
                    fallback_models: [...context.attribution.compositional_routing.fallback_models],
                    ...(context.attribution.compositional_routing.classifier_call_id === undefined
                      ? {}
                      : {
                          classifier_call_id:
                            context.attribution.compositional_routing.classifier_call_id
                        }),
                    inference_call_id: context.callId
                  }
                }
              : {}),
            ...(context.attribution.eval !== undefined
              ? {
                  eval: {
                    purpose: "eval",
                    role: context.attribution.eval.role,
                    run_id: context.attribution.eval.run_id,
                    ...(context.attribution.eval.case_id === undefined
                      ? {}
                      : { case_id: context.attribution.eval.case_id }),
                    policy_bypass: true
                  }
                }
              : {}),
            attempts: context.attribution.attempts,
            retries: context.attribution.retries,
            account_failovers: context.attribution.account_failovers
          }
        }
      : {}),
    ...(callCost.costUsd !== undefined ? { cost_estimate_usd: callCost.costUsd } : {})
  };
  return {
    call_id: context.callId,
    endpoint_id: context.endpointId ?? context.dialect,
    ...(providerRequestId(result.responseBody) !== undefined
      ? { provider_request_id: providerRequestId(result.responseBody) }
      : {}),
    model: context.model ?? context.requestedModel ?? "unknown",
    request_hash: requestHash(context.requestBody),
    ...(result.responseBody !== undefined
      ? { response_hash: responseHash(responseText(result.responseBody)) }
      : {}),
    messages: requestMessages(context.requestBody),
    status: error === undefined ? "succeeded" : "failed",
    side_effects: "none",
    started_at: context.startedAt,
    finished_at: new Date(new Date(context.startedAt).getTime() + result.durationMs).toISOString(),
    latency_ms: result.durationMs,
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
    metadata
  };
}

export function modelCallId(): string {
  return `model_call_${randomUUID()}`;
}

export function responseBodyHash(body: Buffer): string {
  return artifactHash(body);
}
