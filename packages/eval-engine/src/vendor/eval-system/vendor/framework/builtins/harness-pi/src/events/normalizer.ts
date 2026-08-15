import type {
  AgentFailure,
  AgentRuntimeEvent,
  RuntimeNormalizeState,
  RuntimeUsage,
} from "../../../routekit-eval/src/index.ts";

import {
  finalizeRuntimeNormalizeState,
  isTerminalRuntimeEvent,
  parseSessionIdFromRuntimeLine,
} from "../../../routekit-eval/src/index.ts";
import { AgentRuntimeEventTag } from "../../../routekit-eval/src/enums.ts";

import type { PiMessage, PiRawEvent } from "./raw-event.ts";

import { piFailure } from "./failure.ts";
import { decodePiRawEventLine } from "./raw-event.ts";
import { projectPiRawEventToRuntimeEvents } from "./runtime-projector.ts";

const EMPTY_COUNT = 0;
const DEFAULT_TOKENS = 0;

const usageBearingMessage = (event: {
  readonly message?: PiMessage;
  readonly messages?: readonly PiMessage[];
}): PiMessage | undefined => {
  if (event.message?.usage !== undefined) {
    return event.message;
  }
  return event.messages?.findLast((message) => message.usage !== undefined);
};

const isUsageSnapshot = (
  event: PiRawEvent
): event is PiRawEvent & {
  readonly type: "agent_end" | "message_end" | "turn_end";
} =>
  event.type === "agent_end" ||
  event.type === "message_end" ||
  event.type === "turn_end";

const shouldRecordUsage = (
  event: PiRawEvent,
  latestUsage: RuntimeUsage | undefined,
  roundUsageSeen: boolean
): boolean =>
  latestUsage !== undefined &&
  (event.type === "message_end" || !roundUsageSeen);

const piUsageFromMessage = (
  message: PiMessage | undefined
): RuntimeUsage | undefined => {
  const usage = message?.usage;
  if (usage === undefined) {
    return undefined;
  }
  return {
    cacheCreationTokens: usage.cacheWrite ?? DEFAULT_TOKENS,
    cacheReadTokens: usage.cacheRead ?? DEFAULT_TOKENS,
    // Pi reports per-round usage, so the last usage-bearing message's figures
    // ARE the context occupancy after the final model call.
    contextTokens:
      (usage.input ?? DEFAULT_TOKENS) +
      (usage.cacheRead ?? DEFAULT_TOKENS) +
      (usage.cacheWrite ?? DEFAULT_TOKENS) +
      (usage.output ?? DEFAULT_TOKENS),
    costUsd: usage.cost?.total,
    inputTokens: usage.input ?? DEFAULT_TOKENS,
    model: message?.model,
    outputTokens: usage.output ?? DEFAULT_TOKENS,
  };
};

interface PiNormalizeState extends RuntimeNormalizeState {
  readonly emittedAssistantText: boolean;
  readonly promptEchoRemaining?: string | undefined;
  readonly roundUsageSeen: boolean;
  readonly trailingAssistantErrorMessage?: string | undefined;
  readonly turnCostUsd?: number | undefined;
}

const parseSessionId = (line: string): string | null =>
  parseSessionIdFromRuntimeLine(line, {
    decode: decodePiRawEventLine,
    selectSessionId: (decoded) =>
      decoded.event.type === "session" ? decoded.event.id : null,
  });

const nextUsageBookkeeping = (
  event: PiRawEvent,
  state: PiNormalizeState,
  recordedUsage: RuntimeUsage | undefined
): Pick<PiNormalizeState, "roundUsageSeen" | "turnCostUsd" | "usage"> => {
  const nextTurnCostUsd =
    recordedUsage?.costUsd === undefined
      ? state.turnCostUsd
      : (state.turnCostUsd ?? 0) + recordedUsage.costUsd;
  let { usage } = state;
  if (event.type === "agent_start") {
    usage = undefined;
  } else if (recordedUsage !== undefined) {
    usage = {
      ...recordedUsage,
      ...(nextTurnCostUsd === undefined ? {} : { costUsd: nextTurnCostUsd }),
    };
  }
  return {
    roundUsageSeen:
      event.type === "agent_start" || event.type === "turn_start"
        ? false
        : recordedUsage !== undefined || state.roundUsageSeen,
    turnCostUsd: event.type === "agent_start" ? undefined : nextTurnCostUsd,
    usage,
  };
};

const nextTrailingAssistantErrorMessage = (
  event: PiRawEvent,
  previous: string | undefined
): string | undefined => {
  if (event.type !== "message_end" || event.message?.role !== "assistant") {
    return previous;
  }
  return event.message.stopReason === "error"
    ? (event.message.errorMessage ?? "Pi reported an assistant error.")
    : undefined;
};

const projectSessionStarted = (
  state: PiNormalizeState,
  decoded: NonNullable<ReturnType<typeof decodePiRawEventLine>>
): readonly [PiNormalizeState, readonly AgentRuntimeEvent[]] => {
  const sessionId =
    decoded.event.type === "session" ? decoded.event.id?.trim() : undefined;
  if (sessionId === undefined || sessionId.length === EMPTY_COUNT) {
    return [state, []] as const;
  }

  return [
    {
      ...state,
      sessionId,
    },
    [
      {
        payload: {
          sessionId,
        },
        raw: {
          payload: decoded.raw,
          source: "pi",
        },
        type: AgentRuntimeEventTag.SessionStarted,
      },
    ],
  ] as const;
};

// A Pi turn can fail in-band: the process exits 0 but the last assistant
// message stopped with `stopReason: "error"`. Treating that as success would
// report a completed turn that produced no usable answer, so the failure is
// lifted into the terminal completion, matching the Claude harness, whose
// in-band result event decides the terminal `ok`.
const finalizePiNormalizeState = (
  state: PiNormalizeState,
  result?:
    | { readonly ok: true }
    | { readonly failure: AgentFailure; readonly ok: false }
): readonly AgentRuntimeEvent[] => {
  if (
    result?.ok !== false &&
    state.trailingAssistantErrorMessage !== undefined
  ) {
    return finalizeRuntimeNormalizeState(state, {
      failure: piFailure(
        "ROUTEKIT_EVAL_PI_PROVIDER_ERROR",
        state.trailingAssistantErrorMessage,
        { stage: "provider" }
      ),
      ok: false,
    });
  }
  return finalizeRuntimeNormalizeState(state, result);
};

const isSnapshotTextDelta = (
  event: Extract<
    AgentRuntimeEvent,
    { readonly type: typeof AgentRuntimeEventTag.AssistantTextDelta }
  >
): boolean => {
  const payload = event.raw?.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    payload.type === "message_end"
  );
};

const removePromptEcho = (
  state: PiNormalizeState,
  delta: string
): readonly [PiNormalizeState, string | undefined] => {
  const remaining = state.promptEchoRemaining;
  if (state.emittedAssistantText || remaining === undefined) {
    return [state, delta] as const;
  }

  if (remaining.startsWith(delta)) {
    const nextRemaining = remaining.slice(delta.length);
    return [
      {
        ...state,
        promptEchoRemaining:
          nextRemaining.length === EMPTY_COUNT ? undefined : nextRemaining,
      },
      undefined,
    ] as const;
  }

  if (delta.startsWith(remaining)) {
    const nextDelta = delta.slice(remaining.length);
    return [
      {
        ...state,
        promptEchoRemaining: undefined,
      },
      nextDelta.length === EMPTY_COUNT ? undefined : nextDelta,
    ] as const;
  }

  return [
    {
      ...state,
      promptEchoRemaining: undefined,
    },
    delta,
  ] as const;
};

const normalizePromptEcho = (
  prompt: string | undefined
): string | undefined => {
  const trimmed = prompt?.trim();
  return trimmed === undefined || trimmed.length === EMPTY_COUNT
    ? undefined
    : trimmed;
};

const initialPiNormalizeState = (input?: {
  readonly prompt?: string;
}): PiNormalizeState => ({
  emittedAssistantText: false,
  emittedTerminalEvent: false,
  promptEchoRemaining: normalizePromptEcho(input?.prompt),
  roundUsageSeen: false,
  turnCostUsd: undefined,
});

const filterPromptEcho = (
  state: PiNormalizeState,
  events: readonly AgentRuntimeEvent[]
): readonly [PiNormalizeState, readonly AgentRuntimeEvent[]] => {
  let nextState = state;
  const filtered: AgentRuntimeEvent[] = [];

  for (const event of events) {
    if (event.type !== AgentRuntimeEventTag.AssistantTextDelta) {
      filtered.push(event);
      continue;
    }

    if (nextState.emittedAssistantText && isSnapshotTextDelta(event)) {
      continue;
    }

    const [stateAfterEcho, delta] = removePromptEcho(
      nextState,
      event.payload.delta
    );
    nextState = stateAfterEcho;
    if (delta === undefined) {
      continue;
    }

    filtered.push({
      ...event,
      payload: {
        ...event.payload,
        delta,
      },
    });
    nextState = {
      ...nextState,
      emittedAssistantText: true,
    };
  }

  return [nextState, filtered] as const;
};

export const normalizePiJsonLine = (
  state: PiNormalizeState,
  line: string
): readonly [PiNormalizeState, readonly AgentRuntimeEvent[]] => {
  const trimmed = line.trim();
  if (trimmed.length === EMPTY_COUNT) {
    return [state, []] as const;
  }

  const decoded = decodePiRawEventLine(trimmed);
  if (decoded === undefined) {
    return [state, []] as const;
  }

  if (decoded.event.type === "session") {
    return projectSessionStarted(state, decoded);
  }

  const [nextState, events] = filterPromptEcho(
    state,
    projectPiRawEventToRuntimeEvents(decoded)
  );
  const emittedTerminalEvent = events.some(isTerminalRuntimeEvent);
  const latestUsage = isUsageSnapshot(decoded.event)
    ? piUsageFromMessage(usageBearingMessage(decoded.event))
    : undefined;
  const recordedUsage = shouldRecordUsage(
    decoded.event,
    latestUsage,
    nextState.roundUsageSeen
  )
    ? latestUsage
    : undefined;
  const trailingAssistantErrorMessage = nextTrailingAssistantErrorMessage(
    decoded.event,
    nextState.trailingAssistantErrorMessage
  );

  return [
    {
      ...nextState,
      ...nextUsageBookkeeping(decoded.event, nextState, recordedUsage),
      emittedTerminalEvent:
        nextState.emittedTerminalEvent || emittedTerminalEvent,
      trailingAssistantErrorMessage,
    },
    events,
  ] as const;
};

export { parseSessionId, finalizePiNormalizeState, initialPiNormalizeState };
export type { PiNormalizeState };
