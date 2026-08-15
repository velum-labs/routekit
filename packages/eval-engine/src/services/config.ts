import { Data, Redacted, Schema } from "effect";

export const EvalHarnessName = Schema.Literals(["gateway", "pi", "claude", "codex"]);
export type EvalHarnessName = typeof EvalHarnessName.Type;

export interface EvalGatewayConfig {
  readonly inferenceOrigin: string;
  readonly catalogOrigin: string;
  readonly credential: Redacted.Redacted<string>;
  readonly candidateModel: string;
  readonly judgeModel: string;
  readonly authorModel?: string;
  readonly harness: EvalHarnessName;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly spendLimitUsd?: number;
  readonly cachePath?: string;
  readonly statePath?: string;
  readonly childEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly telemetry?: Readonly<Record<string, string | number | boolean>>;
}

const forbiddenModelNames = new Set(["auto", "router", "default"]);

export class EvalConfigurationError extends Data.TaggedError("EvalConfigurationError")<{
  readonly field: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `Invalid RouteKit Eval ${this.field}: ${this.detail}`;
  }
}

export const validateExplicitEvalModel = (
  model: string,
  role: "candidate" | "judge" | "author"
): EvalConfigurationError | undefined => {
  const normalized = model.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    forbiddenModelNames.has(normalized) ||
    normalized.startsWith("auto:") ||
    normalized.startsWith("router:") ||
    normalized.startsWith("default:") ||
    !model.includes("/")
  ) {
    return new EvalConfigurationError({
      field: `${role}Model`,
      detail: "use an explicit provider/model id; routing aliases are forbidden for eval traffic"
    });
  }
  return undefined;
};
