import type { AgentAdapterEvent } from "../../../contracts/internal/src/runtime/agent-adapter-event.ts";
import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";

import { AgentRuntimeEventTag } from "../../../contracts/author/src/index.ts";
import { agentFailure } from "../../../contracts/author/src/errors/agent-failure.ts";

type RuntimeEventBody = Pick<AgentRuntimeEvent, "payload" | "type">;
type LifecycleObservation = Exclude<
  AgentAdapterEvent,
  { readonly event: "acp.session_update" }
>;

const projectRetryObservation = (
  event: Extract<LifecycleObservation, { readonly event: `retry.${string}` }>
): RuntimeEventBody => {
  switch (event.event) {
    case "retry.scheduled": {
      return {
        payload: {
          attempt: event.attempt,
          delayMs: event.delayMs,
          maxAttempts: event.maxAttempts,
          message: event.message,
        },
        type: AgentRuntimeEventTag.RetryScheduled,
      };
    }
    case "retry.completed": {
      return {
        payload: { attempt: event.attempt },
        type: AgentRuntimeEventTag.RetryCompleted,
      };
    }
    case "retry.failed": {
      return {
        payload: {
          attempt: event.attempt,
          failure: agentFailure({
            code: "ORI_ADAPTER_RETRY_FAILED",
            // `message` is already `AgentEventSafeText`, so carrying it costs
            // nothing in safety and is the only thing that says *why* the
            // retries ran out.
            ...(event.message === undefined ? {} : { message: event.message }),
            stage: "adapter",
          }),
        },
        type: AgentRuntimeEventTag.RetryFailed,
      };
    }
    case "retry.cancelled": {
      return {
        payload: { attempt: event.attempt },
        type: AgentRuntimeEventTag.RetryCancelled,
      };
    }
    default: {
      return event satisfies never;
    }
  }
};

const projectCompactionObservation = (
  event: Extract<
    LifecycleObservation,
    { readonly event: `compaction.${string}` }
  >
): RuntimeEventBody => {
  switch (event.event) {
    case "compaction.started": {
      return {
        payload: {
          cause: event.cause,
          trigger: event.trigger,
        },
        type: AgentRuntimeEventTag.CompactionStarted,
      };
    }
    case "compaction.completed": {
      return {
        payload: {
          cause: event.cause,
          durationMs: event.durationMs,
          tokensAfter: event.tokensAfter,
          tokensBefore: event.tokensBefore,
          trigger: event.trigger,
          willRetry: event.willRetry,
        },
        type: AgentRuntimeEventTag.CompactionCompleted,
      };
    }
    case "compaction.failed": {
      return {
        payload: {
          cause: event.cause,
          failure: agentFailure({
            code: "ORI_COMPACTION_FAILED",
            ...(event.message === undefined ? {} : { message: event.message }),
            retryable: event.willRetry,
            stage: "runtime",
          }),
          trigger: event.trigger,
          willRetry: event.willRetry,
        },
        type: AgentRuntimeEventTag.CompactionFailed,
      };
    }
    case "compaction.cancelled": {
      return {
        payload: {
          cause: event.cause,
          trigger: event.trigger,
        },
        type: AgentRuntimeEventTag.CompactionCancelled,
      };
    }
    default: {
      return event satisfies never;
    }
  }
};

export const projectAdapterLifecycleObservation = (
  event: LifecycleObservation
): RuntimeEventBody => {
  switch (event.event) {
    case "retry.scheduled":
    case "retry.completed":
    case "retry.failed":
    case "retry.cancelled": {
      return projectRetryObservation(event);
    }
    case "compaction.started":
    case "compaction.completed":
    case "compaction.failed":
    case "compaction.cancelled": {
      return projectCompactionObservation(event);
    }
    default: {
      return event satisfies never;
    }
  }
};
