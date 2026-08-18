import type { ProviderWireProtocol } from "@velum-labs/routekit-registry";
import type { Backend } from "./backend.js";
import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend,
  OpenAiBackend
} from "./backends.js";

export type ProviderBackendFactoryOptions = {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
};

export function createProviderBackend(
  protocol: ProviderWireProtocol,
  options: ProviderBackendFactoryOptions
): Backend {
  switch (protocol) {
    case "openai":
      return new OpenAiBackend(options);
    case "anthropic":
      return new AnthropicBackend(options);
    case "google":
      return new GoogleGenAiBackend(options);
    case "codex":
      return new CodexResponsesBackend(options);
    case "bedrock":
      throw new Error("Bedrock uses its dedicated AWS SDK provider source");
    default: {
      const unreachable: never = protocol;
      throw new Error(`unsupported provider wire protocol: ${String(unreachable)}`);
    }
  }
}
