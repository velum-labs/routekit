import type { ReasoningEffort } from "./reasoning-effort.ts";

export interface ReasoningParameters {
  readonly effort?: ReasoningEffort | undefined;
}

export interface AgentParameters {
  readonly reasoning?: ReasoningParameters | undefined;
}
