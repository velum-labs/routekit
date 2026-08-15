import type { AgentRuntimeEvent, RuntimeNormalizeState } from "../../ori/src/index.ts";

import {
  filterStreamingTextDeltas,
  finalizeRuntimeNormalizeState,
  isAssistantTextDelta,
  isTerminalRuntimeEvent,
  looksLikeJson,
  normalizeStreamingLine,
  parseSessionIdFromRuntimeLine,
  selectRuntimeSessionId,
} from "../../ori/src/index.ts";
import { AgentRuntimeEventTag } from "../../ori/src/enums.ts";

import { decodeClaudeRawEventLine } from "./raw-event.ts";
import { projectClaudeRawEventToRuntimeEvents } from "./runtime-projector.ts";

interface ClaudeNormalizeState extends RuntimeNormalizeState {
  readonly emittedAssistantText: boolean;
  // toolCallId → tool name, captured from each ToolStarted so the synthesized
  // ToolCompleted (built from a later, name-less tool_result block) can carry
  // the real tool name rather than the "tool" fallback.
  readonly toolNamesById: Readonly<Record<string, string>>;
}

const initialClaudeNormalizeState = (): ClaudeNormalizeState => ({
  emittedAssistantText: false,
  emittedTerminalEvent: false,
  toolNamesById: {},
});

const parseSessionId = (line: string): string | null =>
  parseSessionIdFromRuntimeLine(line, {
    decode: decodeClaudeRawEventLine,
    requireJson: true,
    selectSessionId: ({ event }) => {
      if (event.type === "result") {
        return event.session_id;
      }

      return event.type === "system" && event.subtype === "init"
        ? event.session_id
        : null;
    },
  });

const finalizeClaudeNormalizeState = finalizeRuntimeNormalizeState;

const isAssistantSnapshotTextDelta = (
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
    payload.type === "assistant"
  );
};

const filterSnapshotText = (
  state: ClaudeNormalizeState,
  events: readonly AgentRuntimeEvent[]
): readonly [ClaudeNormalizeState, readonly AgentRuntimeEvent[]] =>
  filterStreamingTextDeltas(state, events, {
    isSnapshotTextDelta: isAssistantSnapshotTextDelta,
    isTextDelta: isAssistantTextDelta,
  });

const rememberToolName = (
  names: Readonly<Record<string, string>>,
  event: AgentRuntimeEvent
): Readonly<Record<string, string>> => {
  if (
    event.type !== AgentRuntimeEventTag.ToolStarted ||
    event.payload.toolCallId === undefined
  ) {
    return names;
  }
  return {
    ...names,
    [event.payload.toolCallId]: event.payload.name,
  };
};

// Claude only emits tool_result (the diagnostic event tapped by `ori logs`, RFC
// 0011), never the ToolCompleted lifecycle terminal that pi emits and every
// renderer + session-state reducer expects. Synthesize it here so the two
// harnesses reach parity; the originating ToolResult is preserved for the
// diagnostic tap.
const toolCompletedFromResult = (
  names: Readonly<Record<string, string>>,
  event: Extract<
    AgentRuntimeEvent,
    {
      readonly type:
        | typeof AgentRuntimeEventTag.ToolResultSucceeded
        | typeof AgentRuntimeEventTag.ToolResultFailed;
    }
  >
): AgentRuntimeEvent => {
  const name =
    event.payload.toolCallId === undefined
      ? undefined
      : names[event.payload.toolCallId];
  return {
    payload: {
      result: event.payload.content,
      name,
      toolCallId: event.payload.toolCallId,
    },
    raw: event.raw,
    type:
      event.type === AgentRuntimeEventTag.ToolResultFailed
        ? AgentRuntimeEventTag.ToolFailed
        : AgentRuntimeEventTag.ToolSucceeded,
  };
};

const synthesizeToolCompleted = (
  state: ClaudeNormalizeState,
  events: readonly AgentRuntimeEvent[]
): readonly [ClaudeNormalizeState, readonly AgentRuntimeEvent[]] => {
  let { toolNamesById } = state;
  const out: AgentRuntimeEvent[] = [];
  for (const event of events) {
    toolNamesById = rememberToolName(toolNamesById, event);
    out.push(event);
    if (
      event.type === AgentRuntimeEventTag.ToolResultSucceeded ||
      event.type === AgentRuntimeEventTag.ToolResultFailed
    ) {
      out.push(toolCompletedFromResult(toolNamesById, event));
    }
  }
  return [
    {
      ...state,
      toolNamesById,
    },
    out,
  ] as const;
};

const transformClaudeEvents = (
  state: ClaudeNormalizeState,
  events: readonly AgentRuntimeEvent[]
): readonly [ClaudeNormalizeState, readonly AgentRuntimeEvent[]] => {
  const [afterFilter, filtered] = filterSnapshotText(state, events);
  return synthesizeToolCompleted(afterFilter, filtered);
};

export const normalizeClaudeJsonLine = (
  state: ClaudeNormalizeState,
  line: string
): readonly [ClaudeNormalizeState, readonly AgentRuntimeEvent[]] =>
  normalizeStreamingLine(state, line, {
    decodeLine: decodeClaudeRawEventLine,
    isTerminalEvent: isTerminalRuntimeEvent,
    projectEvents: projectClaudeRawEventToRuntimeEvents,
    sessionIdFromEvents: selectRuntimeSessionId,
    shouldSkipLine: (trimmed) => !looksLikeJson(trimmed),
    transformEvents: transformClaudeEvents,
  });

export {
  initialClaudeNormalizeState,
  parseSessionId,
  finalizeClaudeNormalizeState,
};
export type { ClaudeNormalizeState };
