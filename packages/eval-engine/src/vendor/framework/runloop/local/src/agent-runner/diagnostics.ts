import type { AgentRuntimeEvent, FeatureLogger } from "../../../../contracts/author/src/index.ts";

import { AgentRuntimeEventTag } from "../../../../contracts/author/src/index.ts";

const TOOL_LOG_MAX_CHARS = 2000;
const summarizeToolContent = (content: unknown): string => {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content.length > TOOL_LOG_MAX_CHARS
      ? `${content.slice(0, TOOL_LOG_MAX_CHARS)}…`
      : content;
  }
  let rendered: string;
  try {
    rendered =
      (JSON.stringify(content) as string | undefined) ?? "[unserializable]";
  } catch {
    rendered = "[unserializable]";
  }
  return rendered.length > TOOL_LOG_MAX_CHARS
    ? `${rendered.slice(0, TOOL_LOG_MAX_CHARS)}…`
    : rendered;
};

/**
 * Forward agent-runtime diagnostic events into `ori logs` without altering the
 * stream rendered by a chat surface.
 */
export const logDiagnosticEvent = (
  logger: FeatureLogger,
  event: AgentRuntimeEvent
): void => {
  if (
    event.type === AgentRuntimeEventTag.ToolResultSucceeded ||
    event.type === AgentRuntimeEventTag.ToolResultFailed
  ) {
    const scoped = logger.child(
      "tool",
      event.payload.name === undefined ? {} : { tool: event.payload.name }
    );
    const fields = {
      toolCallId: event.payload.toolCallId,
      content: summarizeToolContent(event.payload.content),
    };
    if (event.type === AgentRuntimeEventTag.ToolResultFailed) {
      scoped.error("tool reported an error", undefined, fields);
    } else {
      scoped.debug("tool result", fields);
    }
    return;
  }
  if (event.type === AgentRuntimeEventTag.RuntimeError) {
    logger.child("harness").error("runtime error", undefined, {
      code: event.payload.failure.code,
      kind: event.payload.failure.kind,
      message: event.payload.failure.message,
      stage: event.payload.failure.stage,
      upstreamCode: event.payload.failure.upstreamCode,
    });
    return;
  }
  if (event.type === AgentRuntimeEventTag.RuntimeWarning) {
    logger.child("harness").warn(event.payload.message, {
      detail: summarizeToolContent(event.payload.detail),
    });
  }
};
