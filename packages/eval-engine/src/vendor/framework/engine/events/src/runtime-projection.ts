import { Clock, Crypto, Effect, Option, Schema, Stream } from "effect";

import type { AcpSessionUpdate } from "../../../contracts/internal/src/acp/protocol/session-update.ts";
import type {
  HarnessName,
  RunId,
  SessionId,
  TurnId,
} from "../../../contracts/internal/src/ids.ts";
import type { AgentAdapterEvent } from "../../../contracts/internal/src/runtime/agent-adapter-event.ts";
import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import type { RuntimeAgentSessionItemType } from "../../../contracts/internal/src/runtime/agent-session-item.ts";

import { AgentSessionItemStatus } from "../../../contracts/author/src/agent-session/index.ts";
import {
  RuntimeJournalError,
  RuntimeValidationError,
} from "../../../contracts/internal/src/errors.ts";
import { RuntimeEventId } from "../../../contracts/internal/src/ids.ts";
import {
  AgentRuntimeEventTag,
  decodeAgentRuntimeEvent,
  RuntimeUsageSchema,
} from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import { RuntimeEventJournal } from "./event-journal-service.ts";

import { projectAdapterLifecycleObservation } from "./lifecycle-projection.ts";
import {
  projectAvailableCommands,
  projectConfigOptions,
  projectCurrentMode,
  projectContentItem,
  projectPlan,
  projectSessionInfo,
} from "./session-update-projection.ts";

interface RuntimeProjectionContext {
  readonly contextWindow?: number | undefined;
  readonly harness: HarnessName;
  readonly model?: string | null | undefined;
  readonly parentSessionId?: SessionId | undefined;
  readonly runId: RunId;
  readonly sessionId?: SessionId | undefined;
  readonly turnId?: TurnId | undefined;
}

type RuntimeEventBody = Pick<AgentRuntimeEvent, "payload" | "type">;
type AcpSessionUpdateType = typeof AcpSessionUpdate.Type;

type ContentChunkUpdate = Extract<
  AcpSessionUpdateType,
  {
    readonly sessionUpdate:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "user_message_chunk";
  }
>;

type ToolCallUpdate = Extract<
  AcpSessionUpdateType,
  { readonly sessionUpdate: "tool_call_update" }
>;

const RuntimeUsageMeta = Schema.Struct({
  "ori.runtimeUsage": RuntimeUsageSchema,
});

interface RuntimeEventStamp {
  readonly context: RuntimeProjectionContext;
  readonly currentTimeMillis: number;
  readonly eventId: RuntimeEventId;
}

const neutralItemEvent = (
  itemType: RuntimeAgentSessionItemType,
  data: unknown,
  status: AgentSessionItemStatus = AgentSessionItemStatus.Completed
): RuntimeEventBody => ({
  payload: {
    data,
    itemType,
    status,
  },
  type: AgentRuntimeEventTag.ItemCompleted,
});

const contextWindowForUsage = (
  size: number,
  contextWindow: number | undefined
): number | undefined => {
  const candidate = size === 0 ? contextWindow : size;
  return candidate !== undefined &&
    Number.isInteger(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
};

const usageFromAcpMeta = (
  meta: unknown
): typeof RuntimeUsageSchema.Type | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(RuntimeUsageMeta)(meta))?.[
    "ori.runtimeUsage"
  ];

const projectContentChunk = (update: ContentChunkUpdate): RuntimeEventBody => {
  if (update.content.type !== "text") {
    const projected = projectContentItem(update);
    return neutralItemEvent(projected.itemType, projected.data);
  }
  const delta = update.content.text;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      return {
        payload: { delta },
        type: AgentRuntimeEventTag.AssistantTextDelta,
      };
    }
    case "agent_thought_chunk": {
      return {
        payload: { delta },
        type: AgentRuntimeEventTag.ReasoningDelta,
      };
    }
    case "user_message_chunk": {
      return {
        payload: { delta },
        type: AgentRuntimeEventTag.ContentDelta,
      };
    }
    default: {
      return update satisfies never;
    }
  }
};

const projectToolCallUpdate = (update: ToolCallUpdate): RuntimeEventBody => {
  if (update.status === "completed") {
    return {
      payload: {
        name: update.title ?? undefined,
        result: update.rawOutput,
        toolCallId: update.toolCallId,
      },
      type: AgentRuntimeEventTag.ToolSucceeded,
    };
  }
  if (update.status === "failed") {
    return {
      payload: {
        name: update.title ?? undefined,
        result: update.rawOutput,
        toolCallId: update.toolCallId,
      },
      type: AgentRuntimeEventTag.ToolFailed,
    };
  }
  return {
    payload: {
      input: update.rawInput,
      name: update.title ?? undefined,
      partialResult: update.rawOutput,
      toolCallId: update.toolCallId,
    },
    type: AgentRuntimeEventTag.ToolProgress,
  };
};

const projectAcpSessionUpdate = (
  update: AcpSessionUpdateType,
  contextWindow?: number
): RuntimeEventBody => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      return projectContentChunk(update);
    }
    case "tool_call": {
      return {
        payload: {
          input: update.rawInput,
          name: update.title,
          toolCallId: update.toolCallId,
        },
        type: AgentRuntimeEventTag.ToolStarted,
      };
    }
    case "tool_call_update": {
      return projectToolCallUpdate(update);
    }
    case "plan": {
      return neutralItemEvent("plan", projectPlan(update));
    }
    case "available_commands_update": {
      return neutralItemEvent(
        "available_commands",
        projectAvailableCommands(update)
      );
    }
    case "current_mode_update": {
      return neutralItemEvent("current_mode", projectCurrentMode(update));
    }
    case "config_option_update": {
      return neutralItemEvent("config_options", projectConfigOptions(update));
    }
    case "session_info_update": {
      return neutralItemEvent("session_info", projectSessionInfo(update));
    }
    case "usage_update": {
      const projectedContextWindow = contextWindowForUsage(
        update.size,
        contextWindow
      );
      const usage = usageFromAcpMeta(update._meta);
      return neutralItemEvent("usage", {
        contextTokens: update.used,
        ...(projectedContextWindow === undefined
          ? {}
          : {
              contextWindow: projectedContextWindow,
            }),
        ...(update.cost?.currency !== "USD" || update.cost.amount === undefined
          ? {}
          : { cumulativeCostUsd: update.cost.amount }),
        ...(usage === undefined ? {} : { usage }),
      });
    }
    default: {
      return update satisfies never;
    }
  }
};

const projectAdapterObservation = (
  event: Exclude<AgentAdapterEvent, { readonly event: "acp.session_update" }>
): RuntimeEventBody => projectAdapterLifecycleObservation(event);

const projectAdapterEvent = (
  event: AgentAdapterEvent,
  contextWindow?: number
): RuntimeEventBody => {
  if (event.event === "acp.session_update") {
    return projectAcpSessionUpdate(event.update, contextWindow);
  }
  return projectAdapterObservation(event);
};

const stampEvent = (
  body: RuntimeEventBody,
  stamp: RuntimeEventStamp
): unknown => ({
  ...body,
  createdAt: new Date(stamp.currentTimeMillis).toISOString(),
  eventId: stamp.eventId,
  harness: stamp.context.harness,
  model: stamp.context.model,
  parentSessionId: stamp.context.parentSessionId,
  runId: stamp.context.runId,
  sessionId: stamp.context.sessionId,
  turnId: stamp.context.turnId,
});

const projectOneUnpublished = Effect.fn(
  "RuntimeProjection.projectOneUnpublished"
)(function* (event: AgentAdapterEvent, context: RuntimeProjectionContext) {
  const crypto = yield* Crypto.Crypto;
  const currentTimeMillis = yield* Clock.currentTimeMillis;
  const eventId = yield* crypto.randomUUIDv4.pipe(
    Effect.map(RuntimeEventId.make),
    Effect.mapError(
      (cause) =>
        new RuntimeJournalError({
          cause,
          detail: "Could not generate runtime event id",
          operation: "project",
        })
    )
  );
  return yield* decodeAgentRuntimeEvent(
    stampEvent(projectAdapterEvent(event, context.contextWindow), {
      context,
      currentTimeMillis,
      eventId,
    })
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RuntimeValidationError({
          cause,
          detail: "Projected runtime event failed validation",
        })
    )
  );
});

const projectOne = Effect.fn("RuntimeProjection.projectOne")(function* (
  event: AgentAdapterEvent,
  context: RuntimeProjectionContext
) {
  const journal = yield* RuntimeEventJournal;
  const runtimeEvent = yield* projectOneUnpublished(event, context);
  yield* journal.append(runtimeEvent);
  return runtimeEvent;
});

const projectAgentAdapterEvents = <Error, Requirements>(
  events: Stream.Stream<AgentAdapterEvent, Error, Requirements>,
  context: RuntimeProjectionContext
): Stream.Stream<
  AgentRuntimeEvent,
  Error | RuntimeJournalError | RuntimeValidationError,
  Crypto.Crypto | Requirements | RuntimeEventJournal
> => events.pipe(Stream.mapEffect((event) => projectOne(event, context)));

/**
 * Same projection as {@link projectAgentAdapterEvents} without the journal
 * write. A `RuntimeHarness` (RFC 0003) never journals its own output; the
 * daemon's single `appendRuntimeEvent` call site (`daemon-invoke.ts`) owns
 * that for every harness, selected-adapter-backed or not. Journaling here too
 * would double-append every selected-adapter turn once a coordinator-backed
 * harness is registered.
 */
const projectAgentAdapterEventsUnpublished = <Error, Requirements>(
  events: Stream.Stream<AgentAdapterEvent, Error, Requirements>,
  context: RuntimeProjectionContext
): Stream.Stream<
  AgentRuntimeEvent,
  Error | RuntimeJournalError | RuntimeValidationError,
  Crypto.Crypto | Requirements
> =>
  events.pipe(
    Stream.mapEffect((event) => projectOneUnpublished(event, context))
  );

export { projectAgentAdapterEvents, projectAgentAdapterEventsUnpublished };
export type { RuntimeProjectionContext };
