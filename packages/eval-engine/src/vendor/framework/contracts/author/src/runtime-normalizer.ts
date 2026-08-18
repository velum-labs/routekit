import type { AgentRuntimeEvent } from "./agent-event.ts";
import type { AgentFailure } from "./errors/agent-failure.ts";
import type { RuntimeUsage } from "./agent-usage.ts";

import { AgentRuntimeEventTag } from "./agent-event.ts";

const EMPTY_COUNT = 0;

interface RuntimeNormalizeState {
  readonly emittedTerminalEvent: boolean;
  readonly sessionId?: string | undefined;
  /**
   * Cumulative token/cost usage accumulated while streaming. Harnesses that
   * report usage on intermediate events (e.g. pi's turn_end/agent_end) stash
   * the latest here so the synthesized terminal SessionSucceeded/SessionFailed
   * event can carry it.
   */
  readonly usage?: RuntimeUsage | undefined;
}

interface StreamingNormalizeConfig<
  State extends RuntimeNormalizeState,
  Decoded,
  Event,
> {
  readonly decodeLine: (line: string) => Decoded | undefined;
  readonly handleDecoded?:
    | ((
        state: State,
        decoded: Decoded
      ) => readonly [State, readonly Event[]] | undefined)
    | undefined;
  readonly isTerminalEvent: (event: Event) => boolean;
  readonly projectEvents: (decoded: Decoded) => readonly Event[];
  readonly sessionIdFromEvents?:
    | ((events: readonly Event[]) => string | undefined)
    | undefined;
  readonly shouldSkipLine?: ((line: string) => boolean) | undefined;
  readonly transformEvents?:
    | ((
        state: State,
        events: readonly Event[],
        decoded: Decoded
      ) => readonly [State, readonly Event[]])
    | undefined;
}

interface StreamingTextDeltaFilterConfig<
  State,
  Event,
  TextEvent extends Event,
> {
  readonly isSnapshotTextDelta: (event: TextEvent) => boolean;
  readonly isTextDelta: (event: Event) => event is TextEvent;
  readonly transformTextDelta?:
    | ((state: State, event: TextEvent) => readonly [State, Event | undefined])
    | undefined;
}

const normalizeStreamingLine = <
  State extends RuntimeNormalizeState,
  Decoded,
  Event,
>(
  state: State,
  line: string,
  config: StreamingNormalizeConfig<State, Decoded, Event>
): readonly [State, readonly Event[]] => {
  const trimmed = line.trim();
  if (
    trimmed.length === EMPTY_COUNT ||
    config.shouldSkipLine?.(trimmed) === true
  ) {
    return [state, []] as const;
  }

  const decoded = config.decodeLine(trimmed);
  if (decoded === undefined) {
    return [state, []] as const;
  }

  const [nextState, events] =
    config.handleDecoded?.(state, decoded) ??
    config.transformEvents?.(state, config.projectEvents(decoded), decoded) ??
    ([state, config.projectEvents(decoded)] as const);
  const sessionId = config.sessionIdFromEvents?.(events);

  // Spread `nextState` first so generic State extras (e.g. accumulated `usage`)
  // survive; the explicit fields below only override the base contract keys.
  const mergedState: State = {
    ...nextState,
    emittedTerminalEvent:
      nextState.emittedTerminalEvent || events.some(config.isTerminalEvent),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
  return [mergedState, events];
};

const filterStreamingTextDeltas = <
  State extends { readonly emittedAssistantText: boolean },
  Event,
  TextEvent extends Event,
>(
  state: State,
  events: readonly Event[],
  config: StreamingTextDeltaFilterConfig<State, Event, TextEvent>
): readonly [State, readonly Event[]] => {
  let nextState = state;
  const filtered: Event[] = [];

  for (const event of events) {
    if (!config.isTextDelta(event)) {
      filtered.push(event);
      continue;
    }

    if (nextState.emittedAssistantText && config.isSnapshotTextDelta(event)) {
      continue;
    }

    const [stateAfterTransform, nextEvent] = config.transformTextDelta?.(
      nextState,
      event
    ) ?? [nextState, event];
    nextState = stateAfterTransform;
    if (nextEvent === undefined) {
      continue;
    }

    filtered.push(nextEvent);
    nextState = {
      ...nextState,
      emittedAssistantText: true,
    };
  }

  return [nextState, filtered] as const;
};

const finalizeRuntimeNormalizeState = (
  state: RuntimeNormalizeState,
  result?:
    | { readonly ok: true }
    | { readonly failure: AgentFailure; readonly ok: false }
): readonly AgentRuntimeEvent[] => {
  if (state.emittedTerminalEvent) {
    return [];
  }

  const normalizedResult = result ?? { ok: true };
  return [
    normalizedResult.ok
      ? {
          payload: {
            sessionId: state.sessionId,
            usage: state.usage,
          },
          type: AgentRuntimeEventTag.SessionSucceeded,
        }
      : {
          payload: {
            failure: normalizedResult.failure,
            sessionId: state.sessionId,
            usage: state.usage,
          },
          type: AgentRuntimeEventTag.SessionFailed,
        },
  ];
};

const isTerminalRuntimeEvent = (event: AgentRuntimeEvent): boolean =>
  event.type === AgentRuntimeEventTag.SessionSucceeded ||
  event.type === AgentRuntimeEventTag.SessionFailed ||
  event.type === AgentRuntimeEventTag.TurnSucceeded ||
  event.type === AgentRuntimeEventTag.TurnFailed;

/**
 * The harnesses' `shouldSkipFinalize` hook: once the normalizer has emitted a
 * terminal event, the process finalizer must not synthesize another.
 */
const hasEmittedTerminalEvent = (state: RuntimeNormalizeState): boolean =>
  state.emittedTerminalEvent;

/**
 * The session a runtime event belongs to — the one extraction rule every
 * consumer (session store, daemon event filters, CLI metadata sidecar, chat
 * surfaces) shares, so they always agree on which session an event names.
 *
 * The runtime hoists `sessionId` onto event metadata past `session.started`,
 * so metadata wins when present; the `session.started`/`session.succeeded`/
 * `session.failed` payloads seed it otherwise. The author-tier event type
 * does not declare the metadata field (the runtime stamps it), hence the
 * widened intersection parameter.
 */
const agentRuntimeEventSessionId = (
  event: AgentRuntimeEvent & { readonly sessionId?: string | undefined }
): string | undefined => {
  if (event.sessionId !== undefined) {
    return event.sessionId;
  }
  if (
    event.type === AgentRuntimeEventTag.SessionStarted ||
    event.type === AgentRuntimeEventTag.SessionSucceeded ||
    event.type === AgentRuntimeEventTag.SessionFailed
  ) {
    return event.payload.sessionId;
  }
  return undefined;
};

const selectRuntimeSessionId = (
  events: readonly AgentRuntimeEvent[]
): string | undefined =>
  events.find(
    (event) =>
      event.type === AgentRuntimeEventTag.SessionStarted ||
      event.type === AgentRuntimeEventTag.SessionSucceeded ||
      event.type === AgentRuntimeEventTag.SessionFailed
  )?.payload.sessionId;

const normalizeSessionId = (
  value: string | null | undefined
): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === EMPTY_COUNT
    ? null
    : trimmed;
};

/** Cheap JSON-line sniff: does the trimmed line start like an object/array? */
const looksLikeJson = (value: string): boolean =>
  value.startsWith("{") || value.startsWith("[");

export const parseSessionIdFromRuntimeLine = <Decoded>(
  line: string,
  options: {
    readonly decode: (line: string) => Decoded | undefined;
    readonly requireJson?: boolean | undefined;
    readonly selectSessionId: (decoded: Decoded) => string | null | undefined;
  }
): string | null => {
  const trimmed = line.trim();
  if (
    trimmed.length === EMPTY_COUNT ||
    (options.requireJson === true && !looksLikeJson(trimmed))
  ) {
    return null;
  }

  const decoded = options.decode(trimmed);
  if (decoded === undefined) {
    return null;
  }

  return normalizeSessionId(options.selectSessionId(decoded));
};

export {
  agentRuntimeEventSessionId,
  hasEmittedTerminalEvent,
  looksLikeJson,
  normalizeStreamingLine,
  filterStreamingTextDeltas,
  finalizeRuntimeNormalizeState,
  isTerminalRuntimeEvent,
  selectRuntimeSessionId,
};
export type {
  RuntimeNormalizeState,
  StreamingNormalizeConfig,
  StreamingTextDeltaFilterConfig,
};
