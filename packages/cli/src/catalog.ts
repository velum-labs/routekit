import type {
  ModelArchitecture,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";
import { gatewayPath } from "@velum-labs/routekit-runtime";
import { fetchViaHttpClient } from "@velum-labs/routekit-runtime/effect";

export type LiveModel = ModelSelectionSignals & {
  id: string;
  provider?: string;
  capabilities: Readonly<Record<string, string>>;
  architecture?: ModelArchitecture;
  supportedParameters?: readonly string[];
  reasoning?: ModelReasoningCapabilities;
};

export type LiveCatalog = {
  defaultModel: string;
  models: readonly LiveModel[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export async function fetchLiveCatalog(
  gatewayUrl: string,
  input: { authToken?: string; defaultModel?: string } = {}
): Promise<LiveCatalog> {
  const response = await fetchViaHttpClient(gatewayPath(gatewayUrl, "/v1/models"), {
    headers:
      input.authToken === undefined
        ? { accept: "application/json" }
        : {
            accept: "application/json",
            authorization: `Bearer ${input.authToken}`
          }
  });
  if (!response.ok) {
    throw new Error(`gateway model discovery returned HTTP ${response.status}`);
  }
  const payload = record(await response.json());
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const models = data.flatMap((value): LiveModel[] => {
    const entry = record(value);
    if (entry === undefined || typeof entry.id !== "string") return [];
    const capabilities = record(entry.capabilities);
    const architecture = record(entry.architecture);
    const inputModalities = Array.isArray(architecture?.input_modalities)
      ? architecture.input_modalities.filter(
          (modality): modality is string => typeof modality === "string"
        )
      : [];
    const outputModalities = Array.isArray(architecture?.output_modalities)
      ? architecture.output_modalities.filter(
          (modality): modality is string => typeof modality === "string"
        )
      : [];
    const modality =
      typeof architecture?.modality === "string" || architecture?.modality === null
        ? architecture.modality
        : undefined;
    const supportedParameters = Array.isArray(entry.supported_parameters)
      ? entry.supported_parameters.filter(
          (parameter): parameter is string => typeof parameter === "string"
        )
      : [];
    const hasSupportedParameters = Array.isArray(entry.supported_parameters);
    const reasoning = record(entry.reasoning) as ModelReasoningCapabilities | undefined;
    const createdAt = nonNegativeInteger(entry.created);
    const providerPriority = nonNegativeInteger(entry.routekit_provider_priority);
    return [
      {
        id: entry.id,
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(providerPriority !== undefined ? { providerPriority } : {}),
        ...(typeof entry.owned_by === "string" ? { provider: entry.owned_by } : {}),
        capabilities: Object.fromEntries(
          Object.entries(capabilities ?? {}).flatMap(([name, status]) =>
            typeof status === "string" ? [[name, status]] : []
          )
        ),
        ...(architecture !== undefined &&
        (inputModalities.length > 0 || outputModalities.length > 0 || modality !== undefined)
          ? {
              architecture: {
                ...(modality !== undefined ? { modality } : {}),
                inputModalities,
                outputModalities
              }
            }
          : {}),
        ...(hasSupportedParameters ? { supportedParameters } : {}),
        ...(reasoning !== undefined ? { reasoning } : {})
      }
    ];
  });
  if (models.length === 0) throw new Error("gateway model discovery returned no models");
  const ids = models.map((model) => model.id);
  const advertisedDefault =
    typeof payload?.default_model === "string" && ids.includes(payload.default_model)
      ? payload.default_model
      : undefined;
  const defaultModel =
    advertisedDefault ??
    (input.defaultModel !== undefined && ids.includes(input.defaultModel)
      ? input.defaultModel
      : ids[0]!);
  return { defaultModel, models };
}
