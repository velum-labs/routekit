import type { AgentRuntimeEvent } from "../../../ori/src/index.ts";

import { Option } from "effect";
import { AgentRuntimeEventTag } from "../../../ori/src/enums.ts";

import type {
  DecodedPiRawEvent,
  PiRawEvent,
  PiRawPayload,
} from "./raw-event.ts";

import { piCompactionFailure, piFailure } from "./failure.ts";
import {
  decodePiCompactionResultOption,
  decodePiRawEventLine,
} from "./raw-event.ts";
import { runtimeEvent } from "./runtime-event.ts";

const itemTypeFromRole = (role: unknown): string | undefined => {
  if (role === "assistant") {
    return "assistant_message";
  }
  if (role === "user") {
    return "user_message";
  }
  return role === "toolResult" ? "tool_result" : undefined;
};

const projectPiToolExecutionStart = (
  event: PiRawEvent,
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] => [
  runtimeEvent(
    AgentRuntimeEventTag.ToolStarted,
    {
      input: event.args,
      name: event.toolName ?? "unknown",
      toolCallId: event.toolCallId,
    },
    raw
  ),
];

const projectPiToolExecutionUpdate = (
  event: PiRawEvent,
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] => [
  runtimeEvent(
    AgentRuntimeEventTag.ToolProgress,
    {
      input: event.args,
      name: event.toolName,
      partialResult: event.partialResult,
      toolCallId: event.toolCallId,
    },
    raw
  ),
];

const projectPiToolExecutionEnd = (
  event: PiRawEvent,
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] => [
  event.isError === true
    ? runtimeEvent(
        AgentRuntimeEventTag.ToolFailed,
        {
          name: event.toolName,
          result: event.result,
          toolCallId: event.toolCallId,
        },
        raw
      )
    : runtimeEvent(
        AgentRuntimeEventTag.ToolSucceeded,
        {
          name: event.toolName,
          result: event.result,
          toolCallId: event.toolCallId,
        },
        raw
      ),
];

const projectPiMessageLifecycle = (
  event: PiRawEvent,
  raw: PiRawPayload,
  type:
    | typeof AgentRuntimeEventTag.ItemCompleted
    | typeof AgentRuntimeEventTag.ItemStarted
): readonly AgentRuntimeEvent[] => {
  const itemType = itemTypeFromRole(event.message?.role);
  return itemType === undefined
    ? []
    : [
        runtimeEvent(
          type,
          {
            data: event.message,
            itemType,
            status:
              type === AgentRuntimeEventTag.ItemCompleted
                ? "completed"
                : "inProgress",
          },
          raw
        ),
      ];
};

const projectToolResults = (
  toolResults: PiRawEvent["toolResults"],
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] =>
  (toolResults ?? []).flatMap((result): readonly AgentRuntimeEvent[] => [
    result.isError === true
      ? runtimeEvent(
          AgentRuntimeEventTag.ToolResultFailed,
          {
            content: result.content,
            name: result.toolName,
            toolCallId: result.toolCallId,
          },
          raw
        )
      : runtimeEvent(
          AgentRuntimeEventTag.ToolResultSucceeded,
          {
            content: result.content,
            name: result.toolName,
            toolCallId: result.toolCallId,
          },
          raw
        ),
  ]);

type DeltaTag =
  | typeof AgentRuntimeEventTag.AssistantTextDelta
  | typeof AgentRuntimeEventTag.ReasoningDelta
  | typeof AgentRuntimeEventTag.ToolOutputDelta;

interface TextDeltaInput {
  readonly delta: string | undefined;
  readonly tag: DeltaTag;
  readonly contentIndex?: number | undefined;
}

const textDeltaEvent = (
  raw: PiRawPayload,
  input: TextDeltaInput
): readonly AgentRuntimeEvent[] =>
  input.delta === undefined
    ? []
    : [
        runtimeEvent(
          input.tag,
          {
            delta: input.delta,
            contentIndex: input.contentIndex,
          },
          raw
        ),
      ];

// Pi emits turn_end after every internal agent-loop round, so it must not
// project a terminal turnCompleted; the terminal sessionEnded is synthesized
// by finalizePiNormalizeState when the process stream ends.
const projectPiTurnEnd = (
  event: PiRawEvent,
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] => projectToolResults(event.toolResults, raw);

const projectPiMessageUpdate = (
  event: PiRawEvent,
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] => {
  const assistantEvent = event.assistantMessageEvent;
  if (assistantEvent?.type === undefined) {
    return [];
  }

  switch (assistantEvent.type) {
    case "text_delta": {
      return textDeltaEvent(raw, {
        contentIndex: assistantEvent.contentIndex,
        delta: assistantEvent.delta,
        tag: AgentRuntimeEventTag.AssistantTextDelta,
      });
    }
    case "thinking_delta": {
      return textDeltaEvent(raw, {
        contentIndex: assistantEvent.contentIndex,
        delta: assistantEvent.delta,
        tag: AgentRuntimeEventTag.ReasoningDelta,
      });
    }
    // toolcall_start/toolcall_delta/toolcall_end describe the model streaming
    // a tool call, not executing it; tool_execution_start is the authoritative
    // toolStarted source, so projecting them would duplicate every call.
    default: {
      return [];
    }
  }
};

const projectAssistantContent = (
  content: NonNullable<PiRawEvent["message"]>["content"],
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] =>
  (content ?? []).flatMap((block): readonly AgentRuntimeEvent[] => {
    if (block.type === "text" && block.text !== undefined) {
      return textDeltaEvent(raw, {
        delta: block.text,
        tag: AgentRuntimeEventTag.AssistantTextDelta,
      });
    }

    if (block.type === "thinking" && block.thinking !== undefined) {
      return textDeltaEvent(raw, {
        delta: block.thinking,
        tag: AgentRuntimeEventTag.ReasoningDelta,
      });
    }

    // toolCall blocks in the message_end snapshot duplicate the toolStarted
    // already projected from tool_execution_start.
    return [];
  });

const projectPiMessageEnd = (
  event: PiRawEvent,
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] => {
  const itemType = itemTypeFromRole(event.message?.role);
  if (itemType === undefined) {
    return [];
  }

  const events: AgentRuntimeEvent[] = [];
  if (event.message?.role === "assistant") {
    events.push(...projectAssistantContent(event.message.content ?? [], raw));
  }

  events.push(
    runtimeEvent(
      AgentRuntimeEventTag.ItemCompleted,
      {
        data: event.message,
        itemType,
        status: event.message?.stopReason === "error" ? "failed" : "completed",
      },
      raw
    )
  );

  if (event.message?.errorMessage !== undefined) {
    events.push(
      runtimeEvent(
        AgentRuntimeEventTag.RuntimeError,
        {
          failure: piFailure(
            "ORI_PI_PROVIDER_ERROR",
            event.message.errorMessage,
            { stage: "provider" }
          ),
        },
        raw
      )
    );
  }

  return events;
};

// Pi discriminates manual vs auto compaction via `reason`, not the event name:
// "manual" is a user /compact; "threshold"/"overflow" are auto-compaction.
const piCompactionCause = (
  reason: string | undefined
): "threshold" | "overflow" | undefined =>
  reason === "threshold" || reason === "overflow" ? reason : undefined;

const piCompactionTrigger = (
  reason: string | undefined
): "manual" | "automatic" | "unknown" => {
  if (reason === "manual") {
    return "manual";
  }
  return piCompactionCause(reason) === undefined ? "unknown" : "automatic";
};

const nonNegativeInt = (value: number | undefined): number | undefined =>
  value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.round(value));

const projectPiCompactionEnd = (
  event: PiRawEvent,
  raw: PiRawPayload
): readonly AgentRuntimeEvent[] => {
  const cause = piCompactionCause(event.reason);
  const trigger = piCompactionTrigger(event.reason);
  // `aborted` wins over `errorMessage` by design; cancelled has no message field.
  if (event.aborted === true) {
    return [
      runtimeEvent(
        AgentRuntimeEventTag.CompactionCancelled,
        {
          cause,
          trigger,
        },
        raw
      ),
    ];
  }
  if (event.errorMessage !== undefined) {
    return [
      runtimeEvent(
        AgentRuntimeEventTag.CompactionFailed,
        {
          cause,
          failure: piCompactionFailure(event.errorMessage, event.willRetry),
          trigger,
          willRetry: event.willRetry,
        },
        raw
      ),
    ];
  }
  const result = decodePiCompactionResultOption(event.result);
  const tokens = Option.isSome(result) ? result.value : undefined;
  return [
    runtimeEvent(
      AgentRuntimeEventTag.CompactionCompleted,
      {
        cause,
        tokensAfter: nonNegativeInt(tokens?.estimatedTokensAfter),
        tokensBefore: nonNegativeInt(tokens?.tokensBefore),
        trigger,
        willRetry: event.willRetry,
      },
      raw
    ),
  ];
};

export const projectPiRawEventToRuntimeEvents = (
  decoded: DecodedPiRawEvent
): readonly AgentRuntimeEvent[] => {
  const { event, raw } = decoded;
  switch (event.type) {
    case "agent_start": {
      return [];
    }
    case "agent_end": {
      return [];
    }
    case "turn_start": {
      return [runtimeEvent(AgentRuntimeEventTag.TurnStarted, {}, raw)];
    }
    case "turn_end": {
      return projectPiTurnEnd(event, raw);
    }
    case "message_start": {
      return projectPiMessageLifecycle(
        event,
        raw,
        AgentRuntimeEventTag.ItemStarted
      );
    }
    case "message_update": {
      return projectPiMessageUpdate(event, raw);
    }
    case "message_end": {
      return projectPiMessageEnd(event, raw);
    }
    case "tool_execution_start": {
      return projectPiToolExecutionStart(event, raw);
    }
    case "tool_execution_update": {
      return projectPiToolExecutionUpdate(event, raw);
    }
    case "tool_execution_end": {
      return projectPiToolExecutionEnd(event, raw);
    }
    case "compaction_start": {
      return [
        runtimeEvent(
          AgentRuntimeEventTag.CompactionStarted,
          {
            cause: piCompactionCause(event.reason),
            trigger: piCompactionTrigger(event.reason),
          },
          raw
        ),
      ];
    }
    case "compaction_end": {
      return projectPiCompactionEnd(event, raw);
    }
    default: {
      return [];
    }
  }
};

export const projectPiJsonLineToRuntimeEvents = (
  line: string
): readonly AgentRuntimeEvent[] => {
  const decoded = decodePiRawEventLine(line);
  return decoded === undefined ? [] : projectPiRawEventToRuntimeEvents(decoded);
};
