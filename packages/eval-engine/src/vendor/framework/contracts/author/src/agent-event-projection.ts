import type { AgentRuntimeEvent } from "./agent-event.ts";
import type { ValueOf } from "../../../utils/core/src/types.ts";

import { AgentRuntimeEventTag } from "./agent-event.ts";
import { formatAgentFailure } from "./errors/agent-failure.ts";
import { ProjectedEventRole } from "./projected-event-role.ts";

const MAX_TOOL_ARGS = 72;
const EMPTY = "";
const EMPTY_OBJECT = "{}";

/**
 * How a projected event should be rendered. `prose` streams in deltas and is
 * coalesced onto the open line so a reply reads continuously; `line` is a
 * standalone status line a surface prefixes with the glyph it maps to the role.
 */
const ProjectedEventKind = {
  Line: "line",
  Prose: "prose",
} as const;
type ProjectedEventKind = ValueOf<typeof ProjectedEventKind>;

interface ProjectedAgentEvent {
  readonly kind: ProjectedEventKind;
  readonly text: string;
  readonly role: ProjectedEventRole;
}

const line = (role: ProjectedEventRole, text: string): ProjectedAgentEvent => ({
  kind: ProjectedEventKind.Line,
  role,
  text,
});

const prose = (
  role: ProjectedEventRole,
  text: string
): ProjectedAgentEvent => ({
  kind: ProjectedEventKind.Prose,
  role,
  text,
});

type PayloadOf<Tag extends AgentRuntimeEventTag> = Extract<
  AgentRuntimeEvent,
  { readonly type: Tag }
>["payload"];

const projectAssistantTextDelta = (
  payload: PayloadOf<typeof AgentRuntimeEventTag.AssistantTextDelta>
): ProjectedAgentEvent | undefined =>
  payload.delta === EMPTY
    ? undefined
    : prose(ProjectedEventRole.Assistant, payload.delta);

const projectToolFailed = (
  payload: PayloadOf<typeof AgentRuntimeEventTag.ToolFailed>
): ProjectedAgentEvent =>
  line(ProjectedEventRole.Error, `${payload.name ?? "tool"} failed`);

const sessionLine = (sessionId: string | undefined, suffix: string): string =>
  sessionId === undefined || sessionId === EMPTY
    ? `session ${suffix}`
    : `session ${sessionId} ${suffix}`;

const formatPermissionRequest = (operation: string): string =>
  operation === EMPTY
    ? "permission requested"
    : `permission requested: ${operation}`;

const formatElicitationRequest = (message: string): string =>
  message === EMPTY
    ? "waiting for your input"
    : `waiting for your input: ${message}`;

const projectTurnFailed = (
  payload: PayloadOf<typeof AgentRuntimeEventTag.TurnFailed>
): ProjectedAgentEvent =>
  line(
    ProjectedEventRole.Error,
    `turn failed: ${formatAgentFailure(payload.failure)}`
  );

const projectSessionSucceeded = (
  payload: PayloadOf<typeof AgentRuntimeEventTag.SessionSucceeded>
): ProjectedAgentEvent =>
  line(ProjectedEventRole.Success, sessionLine(payload.sessionId, "finished"));

const projectSessionFailed = (
  payload: PayloadOf<typeof AgentRuntimeEventTag.SessionFailed>
): ProjectedAgentEvent =>
  line(
    ProjectedEventRole.Error,
    `${sessionLine(payload.sessionId, "failed")}: ${formatAgentFailure(payload.failure)}`
  );

const compact = (value: unknown): string => {
  // `JSON.stringify` is typed to return `string`, but at runtime yields
  // `undefined` for `undefined`/functions/symbols — and `value` here is
  // `unknown` tool input — so the guard below is load-bearing.
  const text = (typeof value === "string" ? value : JSON.stringify(value)) as
    | string
    | undefined;
  if (text === undefined) {
    return EMPTY;
  }
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length > MAX_TOOL_ARGS
    ? `${collapsed.slice(0, MAX_TOOL_ARGS)}…`
    : collapsed;
};

const formatToolArgs = (input: unknown): string => {
  const text = compact(input);
  return text === EMPTY || text === EMPTY_OBJECT ? EMPTY : `(${text})`;
};

/**
 * Project one runtime event into the single renderable update worth showing, or
 * `undefined` when the event carries nothing a human needs (empty deltas,
 * successful tool results, ok turn completions, and the lower-level item /
 * request lifecycle events). The switch is exhaustive over the event set so a
 * newly added tag is a compile error to forget here.
 */
// An if-chain rather than a switch so this stays out of the main switch's
// complexity budget and does not trip the switch-exhaustiveness rule.
const projectOutcomeEvent = (
  event: AgentRuntimeEvent
): ProjectedAgentEvent | undefined => {
  if (event.type === AgentRuntimeEventTag.SessionSucceeded) {
    return projectSessionSucceeded(event.payload);
  }
  if (event.type === AgentRuntimeEventTag.SessionFailed) {
    return projectSessionFailed(event.payload);
  }
  if (event.type === AgentRuntimeEventTag.ToolFailed) {
    return projectToolFailed(event.payload);
  }
  if (event.type === AgentRuntimeEventTag.TurnFailed) {
    return projectTurnFailed(event.payload);
  }
  return undefined;
};

const projectSimpleLineEvent = (
  event: AgentRuntimeEvent
): ProjectedAgentEvent | undefined => {
  if (event.type === AgentRuntimeEventTag.SessionStarted) {
    return line(
      ProjectedEventRole.Session,
      sessionLine(event.payload.sessionId, "started")
    );
  }
  if (event.type === AgentRuntimeEventTag.ToolStarted) {
    return line(
      ProjectedEventRole.Tool,
      `${event.payload.name}${formatToolArgs(event.payload.input)}`
    );
  }
  if (event.type === AgentRuntimeEventTag.RuntimeWarning) {
    return line(ProjectedEventRole.Warning, event.payload.message);
  }
  if (event.type === AgentRuntimeEventTag.RuntimeError) {
    return line(
      ProjectedEventRole.Error,
      formatAgentFailure(event.payload.failure)
    );
  }
  if (event.type === AgentRuntimeEventTag.PermissionRequested) {
    return line(
      ProjectedEventRole.Warning,
      formatPermissionRequest(event.payload.operation)
    );
  }
  if (event.type === AgentRuntimeEventTag.ElicitationRequested) {
    return line(
      ProjectedEventRole.Warning,
      formatElicitationRequest(event.payload.message)
    );
  }
  return undefined;
};

// Typed as a full record over the tag union so adding a new tag is a compile
// error until it is classified here or handled by one of the projection
// helpers above.
const SILENT_EVENT_TAGS: Readonly<Record<AgentRuntimeEventTag, boolean>> = {
  [AgentRuntimeEventTag.AssistantTextDelta]: false,
  [AgentRuntimeEventTag.CompactionCancelled]: true,
  [AgentRuntimeEventTag.CompactionCompleted]: true,
  [AgentRuntimeEventTag.CompactionFailed]: true,
  [AgentRuntimeEventTag.CompactionStarted]: true,
  [AgentRuntimeEventTag.ContentDelta]: true,
  [AgentRuntimeEventTag.ReasoningDelta]: true,
  [AgentRuntimeEventTag.ToolOutputDelta]: true,
  [AgentRuntimeEventTag.ElicitationRequested]: false,
  [AgentRuntimeEventTag.ElicitationResolved]: true,
  [AgentRuntimeEventTag.ItemCompleted]: true,
  [AgentRuntimeEventTag.ItemStarted]: true,
  [AgentRuntimeEventTag.ItemUpdated]: true,
  [AgentRuntimeEventTag.PermissionRequested]: false,
  [AgentRuntimeEventTag.PermissionResolved]: true,
  [AgentRuntimeEventTag.RetryCancelled]: true,
  [AgentRuntimeEventTag.RetryCompleted]: true,
  [AgentRuntimeEventTag.RetryFailed]: true,
  [AgentRuntimeEventTag.RetryScheduled]: true,
  [AgentRuntimeEventTag.RunStarted]: true,
  [AgentRuntimeEventTag.RuntimeError]: false,
  [AgentRuntimeEventTag.RuntimeWarning]: false,
  [AgentRuntimeEventTag.SessionFailed]: false,
  [AgentRuntimeEventTag.SessionStarted]: false,
  [AgentRuntimeEventTag.SessionSucceeded]: false,
  [AgentRuntimeEventTag.ToolFailed]: false,
  [AgentRuntimeEventTag.ToolProgress]: true,
  [AgentRuntimeEventTag.ToolResultFailed]: true,
  [AgentRuntimeEventTag.ToolResultSucceeded]: true,
  [AgentRuntimeEventTag.ToolStarted]: false,
  [AgentRuntimeEventTag.ToolSucceeded]: true,
  [AgentRuntimeEventTag.TurnFailed]: false,
  [AgentRuntimeEventTag.TurnStarted]: true,
  [AgentRuntimeEventTag.TurnSucceeded]: true,
};

export const projectAgentRuntimeEvent = (
  event: AgentRuntimeEvent
): ProjectedAgentEvent | undefined => {
  if (SILENT_EVENT_TAGS[event.type]) {
    return undefined;
  }
  if (event.type === AgentRuntimeEventTag.AssistantTextDelta) {
    return projectAssistantTextDelta(event.payload);
  }
  return projectSimpleLineEvent(event) ?? projectOutcomeEvent(event);
};

export { ProjectedEventKind, ProjectedEventRole };
export type { ProjectedAgentEvent };
