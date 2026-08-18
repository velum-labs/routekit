import type { AgentFailure, AgentRuntimeEvent, RuntimeUsage } from "../../ori/src/index.ts";

import { agentFailure } from "../../ori/src/index.ts";
import { AgentRuntimeEventTag } from "../../ori/src/enums.ts";

import type {
  ClaudeAssistantEvent,
  ClaudeRawPayload,
  ClaudeResultEvent,
  ClaudeStreamEvent,
  ClaudeSystemEvent,
  ClaudeUserEvent,
  DecodedClaudeRawEvent,
} from "./raw-event.ts";

import { claudeFailure } from "./failure.ts";
import { decodeClaudeRawEventLine } from "./raw-event.ts";

const runtimeEvent = <Event extends AgentRuntimeEvent>(
  type: Event["type"],
  payload: Event["payload"],
  raw: ClaudeRawPayload
): Event => {
  const event = {
    payload,
    raw: {
      payload: raw,
      source: "claude",
    },
    type,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return event as Event;
};

const claudeCompactionTrigger = (
  trigger: string | undefined
): "manual" | "automatic" | "unknown" => {
  if (trigger === "manual") {
    return "manual";
  }
  return trigger === "auto" ? "automatic" : "unknown";
};

// Claude reports only the completed compaction boundary — no start/failure
// events — so completion-without-start is the expected shape here.
const projectCompactBoundaryEvent = (
  event: ClaudeSystemEvent,
  raw: ClaudeRawPayload
): AgentRuntimeEvent => {
  const metadata = event.compact_metadata ?? event.compactMetadata;
  const preTokens = metadata?.pre_tokens ?? metadata?.preTokens;
  return runtimeEvent(
    AgentRuntimeEventTag.CompactionCompleted,
    {
      tokensBefore:
        preTokens === undefined || !Number.isFinite(preTokens)
          ? undefined
          : Math.max(0, Math.round(preTokens)),
      trigger: claudeCompactionTrigger(metadata?.trigger),
    },
    raw
  );
};

const projectSystemEvent = (
  event: ClaudeSystemEvent,
  raw: ClaudeRawPayload
): readonly AgentRuntimeEvent[] => {
  if (event.subtype === "init") {
    return [
      runtimeEvent(
        AgentRuntimeEventTag.SessionStarted,
        { sessionId: event.session_id },
        raw
      ),
    ];
  }

  if (event.subtype === "api_retry") {
    return [
      runtimeEvent(
        AgentRuntimeEventTag.RuntimeWarning,
        { message: event.error ?? "Claude API retry" },
        raw
      ),
    ];
  }

  if (event.subtype === "plugin_install" && event.status === "failed") {
    return [
      runtimeEvent(
        AgentRuntimeEventTag.RuntimeError,
        {
          // Built directly, not through `claudeFailure`: the operation is
          // already known here, and the prose classifiers would happily rename
          // a plugin install into a session or overflow failure. Claude's own
          // sentence still rides along as the message, since it is the only
          // text that says which plugin failed and why.
          failure: agentFailure({
            code: "ORI_CLAUDE_PLUGIN_INSTALL_FAILED",
            kind: "configuration",
            ...(event.error === undefined ? {} : { message: event.error }),
            stage: "harness",
          }),
        },
        raw
      ),
    ];
  }

  if (event.subtype === "compact_boundary") {
    return [projectCompactBoundaryEvent(event, raw)];
  }

  return [];
};

const projectUserEvent = (
  event: ClaudeUserEvent,
  raw: ClaudeRawPayload
): readonly AgentRuntimeEvent[] => {
  const content = event.message?.content ?? [];
  return content.flatMap((block): readonly AgentRuntimeEvent[] => {
    if (
      block.type !== "tool_result" &&
      block.type !== "web_search_tool_result"
    ) {
      return [];
    }

    return [
      block.is_error === true
        ? runtimeEvent(
            AgentRuntimeEventTag.ToolResultFailed,
            {
              content: block.content,
              toolCallId: block.tool_use_id,
            },
            raw
          )
        : runtimeEvent(
            AgentRuntimeEventTag.ToolResultSucceeded,
            {
              content: block.content,
              toolCallId: block.tool_use_id,
            },
            raw
          ),
    ];
  });
};

interface TextDeltaInput {
  readonly delta: string;
  readonly contentIndex?: number | undefined;
}

// Claude streams only assistant prose (reasoning is not surfaced as a separate
// stream), so every text delta projects to AssistantTextDelta.
const textDeltaEvent = (
  raw: ClaudeRawPayload,
  input: TextDeltaInput
): readonly AgentRuntimeEvent[] => [
  runtimeEvent(
    AgentRuntimeEventTag.AssistantTextDelta,
    {
      delta: input.delta,
      contentIndex: input.contentIndex,
    },
    raw
  ),
];

const projectAssistantEvent = (
  event: ClaudeAssistantEvent,
  raw: ClaudeRawPayload
): readonly AgentRuntimeEvent[] => {
  const content = event.message?.content ?? [];
  return [
    ...content.flatMap((block): readonly AgentRuntimeEvent[] => {
      if (block.type === "text" && block.text !== undefined) {
        return textDeltaEvent(raw, {
          delta: block.text,
        });
      }

      if (block.type === "tool_use" && block.name !== undefined) {
        return [
          runtimeEvent(
            AgentRuntimeEventTag.ToolStarted,
            {
              input: block.input,
              name: block.name,
              toolCallId: block.id,
            },
            raw
          ),
        ];
      }

      return [];
    }),
    runtimeEvent(
      AgentRuntimeEventTag.ItemCompleted,
      {
        data: event.message,
        itemType: "assistant_message",
        status: "completed",
      },
      raw
    ),
  ];
};

const projectStreamEvent = (
  event: ClaudeStreamEvent,
  raw: ClaudeRawPayload
): readonly AgentRuntimeEvent[] => {
  if (
    event.event?.type !== "content_block_delta" ||
    event.event.delta?.type !== "text_delta" ||
    event.event.delta.text === undefined
  ) {
    return [];
  }

  return textDeltaEvent(raw, {
    contentIndex: event.event.index,
    delta: event.event.delta.text,
  });
};

/**
 * Text Claude produced *as an error*, used only to classify the failure.
 *
 * `event.result` is read last and only when Claude set `is_error`, because on
 * any other result it holds the assistant's own last message and classifying
 * that makes a model musing about its context window look like a context
 * overflow. On an error result it is where Claude puts the reason, and often the
 * only place it does: without it an overflow reaches the runtime as a plain
 * session failure, so the rollover that the same overflow arms on pi never arms
 * here and the run just stops.
 */
const extractError = (event: ClaudeResultEvent): string =>
  event.error ??
  event.message ??
  event.errors?.[0] ??
  (event.is_error === true ? event.result : undefined) ??
  "Claude emitted an error.";

const CLAUDE_TURN_LIMIT_SUBTYPE = "error_max_turns";

const claudeResultFailure = (event: ClaudeResultEvent): AgentFailure =>
  event.subtype === CLAUDE_TURN_LIMIT_SUBTYPE
    ? claudeFailure("ORI_CLAUDE_TURN_LIMIT", "", {
        stage: "harness",
        upstreamCode: event.subtype,
      })
    : claudeFailure("ORI_CLAUDE_SESSION_FAILED", extractError(event), {
        stage: "provider",
        ...(event.subtype === undefined ? {} : { upstreamCode: event.subtype }),
      });

const DEFAULT_TOKENS = 0;

/**
 * Normalize a Claude `result` event into harness-neutral usage. Token counts
 * are taken from `modelUsage` (the first model entry) when present, falling back
 * to the top-level `usage` otherwise.
 *
 * Why prefer `modelUsage`: on a multi-turn run the top-level `usage` reports
 * only the FINAL API turn's tokens, whereas `modelUsage[<model>]` carries the
 * run's CUMULATIVE totals — and those are what `total_cost_usd` is computed
 * from. Reading `usage` would show e.g. `↑ 2 ↓ 22` next to a cost derived from
 * `↑ 630 ↓ 39`, an internally inconsistent footer (observed in the
 * full-conversation fixture). `modelUsage` keeps tokens and cost in agreement.
 * The top-level-`usage` fallback covers single-turn results that omit
 * `modelUsage` entirely.
 */
// First defined value wins, else 0. Keeps the per-field cumulative→usage→default
// fallbacks out of extractClaudeUsage so it stays under the complexity budget.
const tokens = (...values: readonly (number | undefined)[]): number =>
  values.find((value) => value !== undefined) ?? DEFAULT_TOKENS;

const extractClaudeUsage = (
  event: ClaudeResultEvent
): RuntimeUsage | undefined => {
  const { modelUsage, total_cost_usd, usage } = event;
  if (
    usage === undefined &&
    total_cost_usd === undefined &&
    modelUsage === undefined
  ) {
    return undefined;
  }
  const modelEntry =
    modelUsage === undefined ? undefined : Object.entries(modelUsage)[0];
  const cumulative = modelEntry?.[1];
  return {
    cacheCreationTokens: tokens(
      cumulative?.cacheCreationInputTokens,
      usage?.cache_creation_input_tokens
    ),
    cacheReadTokens: tokens(
      cumulative?.cacheReadInputTokens,
      usage?.cache_read_input_tokens
    ),
    // Occupancy comes from the TOP-LEVEL usage on purpose: it reports only the
    // FINAL API call, which is what actually sits in the context window. The
    // cumulative modelUsage preferred for the token/cost fields would
    // overcount occupancy by roughly the number of agentic API calls.
    contextTokens:
      usage === undefined
        ? undefined
        : tokens(usage.input_tokens) +
          tokens(usage.cache_read_input_tokens) +
          tokens(usage.cache_creation_input_tokens) +
          tokens(usage.output_tokens),
    costUsd: total_cost_usd,
    inputTokens: tokens(cumulative?.inputTokens, usage?.input_tokens),
    model: modelEntry?.[0],
    outputTokens: tokens(cumulative?.outputTokens, usage?.output_tokens),
  };
};

const projectResultEvent = (
  event: ClaudeResultEvent,
  raw: ClaudeRawPayload
): readonly AgentRuntimeEvent[] => {
  const ok = event.is_error !== true;
  const usage = extractClaudeUsage(event);
  return [
    ok
      ? runtimeEvent(
          AgentRuntimeEventTag.SessionSucceeded,
          {
            sessionId: event.session_id,
            usage,
          },
          raw
        )
      : runtimeEvent(
          AgentRuntimeEventTag.SessionFailed,
          {
            failure: claudeResultFailure(event),
            sessionId: event.session_id,
            usage,
          },
          raw
        ),
  ];
};

export const projectClaudeRawEventToRuntimeEvents = (
  decoded: DecodedClaudeRawEvent
): readonly AgentRuntimeEvent[] => {
  const { event, raw } = decoded;
  switch (event.type) {
    case "system": {
      return projectSystemEvent(event, raw);
    }
    case "assistant": {
      return projectAssistantEvent(event, raw);
    }
    case "user": {
      return projectUserEvent(event, raw);
    }
    case "stream_event": {
      return projectStreamEvent(event, raw);
    }
    case "result": {
      return projectResultEvent(event, raw);
    }
    case "agent_error":
    case "error": {
      return [
        runtimeEvent(
          AgentRuntimeEventTag.RuntimeError,
          {
            failure: claudeFailure(
              "ORI_CLAUDE_RUNTIME_ERROR",
              extractError(event),
              { stage: "provider" }
            ),
          },
          raw
        ),
      ];
    }
    default: {
      return [];
    }
  }
};

export const projectClaudeJsonLineToRuntimeEvents = (
  line: string
): readonly AgentRuntimeEvent[] => {
  const decoded = decodeClaudeRawEventLine(line);
  return decoded === undefined
    ? []
    : projectClaudeRawEventToRuntimeEvents(decoded);
};
