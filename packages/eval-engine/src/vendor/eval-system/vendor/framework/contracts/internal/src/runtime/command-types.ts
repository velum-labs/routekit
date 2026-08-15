import type { HarnessOutputSchema } from "../../../author/src/index.ts";
import type { AgentParameters } from "../../../author/src/parameters.ts";
import type {
  HarnessName,
  RuntimeCommandId,
  SessionId,
} from "../ids.ts";

/**
 * The fork-thread directive on {@link InvokeRuntimeCommand} (Fork Thread, RFC
 * 0003). When present the daemon summarizes `parentSessionId`, mints a new
 * sibling session seeded with that summary, sets the child's lineage, and
 * streams the child's run. Mutually exclusive with a top-level resume
 * `sessionId` — forking always mints a new child.
 */
export interface ForkThreadDirective {
  readonly parentSessionId: SessionId;
}

/**
 * The invocation fields every tier of an agent run shares. This is the one
 * place a new per-run knob is declared: the wire command (this file), the
 * runner command (`AgentRunnerCommand` in the runloop), and the projections
 * between them all extend or pick from this core, so adding a field is one
 * declaration plus the projections that choose to forward it — not a parallel
 * edit across three hand-synced field lists.
 */
export interface AgentInvocationCore {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly parameters?: AgentParameters | undefined;
  readonly harnessName?: HarnessName | undefined;
  readonly interactionSurface?: boolean | undefined;
  readonly model?: string | null | undefined;
  readonly outputSchema?: HarnessOutputSchema | undefined;
  readonly prompt: string;
  readonly sessionId?: SessionId | undefined;
  readonly telemetrySurface?: string | undefined;
  readonly systemPrompt?: string | undefined;
  readonly temperature?: number | undefined;
  /**
   * Optional identity of the user this run is invoked on behalf of (ROUTEKIT_EVAL-361).
   * A caller (chat surface, API, CLI) may inject it at `agent.invoke` time so a
   * builtin harness can attribute or scope work to that user without smuggling
   * it through `env` or the prompt. Optional and back-compatible: callers that
   * omit it are unaffected. Recorded per run (folded onto `run.started` and
   * `SessionRunMetadata`), so a resumed or forked run can re-specify it and
   * per-run attribution is preserved.
   */
  readonly userId?: string | undefined;
}

/**
 * Copy exactly the {@link AgentInvocationCore} fields off a wider command.
 * Projections use this instead of listing the shared fields again, so a field
 * added to the core flows through every tier without further edits.
 */
export const projectAgentInvocationCore = (
  command: AgentInvocationCore
): AgentInvocationCore => ({
  env: command.env,
  parameters: command.parameters,
  harnessName: command.harnessName,
  interactionSurface: command.interactionSurface,
  model: command.model,
  outputSchema: command.outputSchema,
  prompt: command.prompt,
  sessionId: command.sessionId,
  telemetrySurface: command.telemetrySurface,
  systemPrompt: command.systemPrompt,
  temperature: command.temperature,
  userId: command.userId,
});

export interface InvokeRuntimeCommand extends AgentInvocationCore {
  readonly commandId: RuntimeCommandId;
  readonly cwd?: string | undefined;
  readonly featuresRoot?: string | undefined;
  /**
   * Force a rollover before this turn (manual /compact fallback): the daemon
   * summarizes the resumed session and re-seeds a fresh one regardless of the
   * occupancy threshold. Ignored without a sessionId to roll over.
   */
  readonly forceRollover?: boolean | undefined;
  readonly fork?: ForkThreadDirective | undefined;
  readonly type: "agent.invoke";
}

export type RuntimeCommand = InvokeRuntimeCommand;
