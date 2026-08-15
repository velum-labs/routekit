import type {
  AgentInteractionRequest,
  AgentRuntimeEvent,
  AgentSessionEvent,
} from "../../../contracts/author/src/index.ts";

import { agentFailure } from "../../../contracts/author/src/errors/agent-failure.ts";

type ContentDelta = Extract<AgentSessionEvent, { event: "content.delta" }>;
type ToolStarted = Extract<AgentSessionEvent, { event: "tool.started" }>;
type ToolUpdated = Extract<AgentSessionEvent, { event: "tool.updated" }>;
type ItemEvent = Extract<AgentSessionEvent, { event: "item" }>;
type LifecycleEvent = Exclude<
  AgentSessionEvent,
  | ContentDelta
  | ToolStarted
  | ToolUpdated
  | ItemEvent
  | Extract<
      AgentSessionEvent,
      {
        event:
          | "plan"
          | "available_commands"
          | "current_mode"
          | "config_options"
          | "session_info"
          | "usage";
      }
    >
>;

const projectInteraction = (
  request: AgentInteractionRequest
): AgentRuntimeEvent => {
  if (request.kind === "permission") {
    return {
      payload: {
        correlationId: request.correlationId,
        operation: request.operation,
        options: request.options,
      },
      type: "permission.requested",
    };
  }
  return {
    payload: {
      correlationId: request.correlationId,
      fields: request.fields,
      message: request.message,
    },
    type: "elicitation.requested",
  };
};

const contentDeltaType = (
  role: ContentDelta["role"]
): "assistant.text.delta" | "reasoning.delta" | "content.delta" => {
  if (role === "assistant") {
    return "assistant.text.delta";
  }
  if (role === "reasoning") {
    return "reasoning.delta";
  }
  return "content.delta";
};

const projectContentDelta = (event: ContentDelta): AgentRuntimeEvent => ({
  payload: {
    contentIndex: event.contentIndex,
    delta: event.delta,
    itemId: event.itemId,
  },
  type: contentDeltaType(event.role),
});

const projectToolStarted = (event: ToolStarted): AgentRuntimeEvent => ({
  payload: {
    input: event.input,
    name: event.name,
    toolCallId: event.toolCallId,
  },
  type: "tool.started",
});

const projectToolUpdated = (event: ToolUpdated): AgentRuntimeEvent => {
  if (event.status === "failed" || event.status === "completed") {
    return {
      payload: {
        name: event.name,
        result: event.output,
        toolCallId: event.toolCallId,
      },
      type: event.status === "failed" ? "tool.failed" : "tool.succeeded",
    };
  }
  return {
    payload: {
      input: event.input,
      name: event.name,
      partialResult: event.output,
      toolCallId: event.toolCallId,
    },
    type: "tool.progress",
  };
};

const itemType = (
  status: ItemEvent["status"]
): "item.started" | "item.updated" | "item.completed" => {
  if (status === "inProgress") {
    return "item.started";
  }
  if (status === undefined) {
    return "item.updated";
  }
  return "item.completed";
};

const projectItem = (event: ItemEvent): AgentRuntimeEvent => ({
  payload: {
    data: event.data,
    itemId: event.itemId,
    itemType: event.itemType,
    status: event.status,
  },
  type: itemType(event.status),
});

const projectRuntimeItem = (
  event: Extract<
    AgentSessionEvent,
    {
      event:
        | "plan"
        | "available_commands"
        | "current_mode"
        | "config_options"
        | "session_info"
        | "usage";
    }
  >
): AgentRuntimeEvent => ({
  payload: {
    data: event.data,
    itemType: event.event,
    status: "completed",
  },
  type: "item.completed",
});

// A third-party author ships JavaScript, so an event outside the union can
// arrive at runtime. It degrades to a warning instead of failing the turn,
// matching how the registerPrompt path treats undecodable events.
const unsupportedEventWarning = (detail: unknown): AgentRuntimeEvent => ({
  payload: {
    detail,
    message: "Unsupported session event",
  },
  type: "runtime.warning",
});

const projectLifecycle = (event: LifecycleEvent): AgentRuntimeEvent => {
  if (event.event === "retry.scheduled") {
    return {
      payload: {
        attempt: event.attempt,
        delayMs: event.delayMs,
        message: event.message,
      },
      type: "retry.scheduled",
    };
  }
  if (event.event === "retry.failed") {
    return {
      payload: {
        attempt: event.attempt,
        failure: agentFailure({
          code: "ORI_ADAPTER_RETRY_FAILED",
          stage: "adapter",
          message: event.message,
        }),
      },
      type: "retry.failed",
    };
  }
  if (event.event === "retry.completed" || event.event === "retry.cancelled") {
    return {
      payload: { attempt: event.attempt },
      type: event.event,
    };
  }
  const trigger = event.trigger ?? "unknown";
  if (event.event === "compaction.failed") {
    return {
      payload: {
        failure: agentFailure({
          code: "ORI_COMPACTION_FAILED",
          stage: "runtime",
          message: event.message,
        }),
        trigger,
      },
      type: "compaction.failed",
    };
  }
  switch (event.event) {
    case "compaction.started":
    case "compaction.completed":
    case "compaction.cancelled": {
      return {
        payload: { trigger },
        type: event.event,
      };
    }
    default: {
      return unsupportedEventWarning(event);
    }
  }
};

const projectSessionEvent = (
  event: AgentSessionEvent | AgentInteractionRequest
): AgentRuntimeEvent => {
  if ("kind" in event) {
    return projectInteraction(event);
  }
  switch (event.event) {
    case "content.delta": {
      return projectContentDelta(event);
    }
    case "tool.started": {
      return projectToolStarted(event);
    }
    case "tool.updated": {
      return projectToolUpdated(event);
    }
    case "item": {
      return projectItem(event);
    }
    case "plan":
    case "available_commands":
    case "current_mode":
    case "config_options":
    case "session_info":
    case "usage": {
      return projectRuntimeItem(event);
    }
    case "retry.scheduled": {
      return projectLifecycle(event);
    }
    case "retry.completed": {
      return projectLifecycle(event);
    }
    case "retry.failed": {
      return projectLifecycle(event);
    }
    case "retry.cancelled": {
      return projectLifecycle(event);
    }
    case "compaction.started": {
      return projectLifecycle(event);
    }
    case "compaction.completed": {
      return projectLifecycle(event);
    }
    case "compaction.failed": {
      return projectLifecycle(event);
    }
    case "compaction.cancelled": {
      return projectLifecycle(event);
    }
    default: {
      return unsupportedEventWarning(event);
    }
  }
};

export { projectSessionEvent };
