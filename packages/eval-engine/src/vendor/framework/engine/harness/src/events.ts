import type { Crypto } from "effect";

import { Effect } from "effect";

import type {
  AgentRuntimeEvent as AuthorAgentRuntimeEvent,
  RuntimeUsage,
} from "../../../contracts/author/src/index.ts";
import type { AgentFailure } from "../../../contracts/author/src/errors/agent-failure.ts";
import type { HarnessProtocolError } from "../../../contracts/internal/src/errors.ts";
import type { HarnessName, SessionId } from "../../../contracts/internal/src/ids.ts";
import type {
  AgentRuntimeEvent,
  AgentRuntimeRawEvent,
} from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";

import { HarnessProtocolError as HarnessProtocolFailure } from "../../../contracts/internal/src/errors.ts";
import { RunId, RuntimeEventId, TurnId } from "../../../contracts/internal/src/ids.ts";
import { AgentRuntimeEventTag } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

interface HarnessEventState {
  readonly currentTimeMillis: number;
  readonly emittedTerminalEvent: boolean;
  readonly eventSequence: number;
  readonly harness: HarnessName;
  readonly model?: string | null;
  readonly runId: RunId;
  readonly sessionId?: SessionId;
  readonly turnId: TurnId;
  readonly usage?: RuntimeUsage;
}

interface HarnessEventIds {
  readonly runId: RunId;
  readonly turnId: TurnId;
}

const makeHarnessEventIds = (
  crypto: Crypto.Crypto
): Effect.Effect<HarnessEventIds, HarnessProtocolError> =>
  Effect.all([crypto.randomUUIDv4, crypto.randomUUIDv4]).pipe(
    Effect.map(([runId, turnId]) => ({
      runId: RunId.make(runId),
      turnId: TurnId.make(turnId),
    })),
    Effect.mapError(
      (cause) =>
        new HarnessProtocolFailure({
          cause,
          detail: `Could not generate harness event ids: ${formatUnknownError(cause)}`,
        })
    )
  );

interface RuntimeEventMetadata {
  readonly createdAt: string;
  readonly eventId: RuntimeEventId;
  readonly harness: HarnessName;
  readonly model?: string | null;
  readonly raw?: AgentRuntimeRawEvent;
  readonly runId: RunId;
  readonly sessionId?: SessionId;
  readonly turnId: TurnId;
}

interface HarnessStartOptions {
  readonly cwd?: string | undefined;
  readonly model?: string | null | undefined;
  readonly prompt: string;
  readonly userId?: string | undefined;
}

const initialHarnessEventState = (
  harness: HarnessName,
  currentTimeMillis: number,
  ids: HarnessEventIds
): HarnessEventState => ({
  currentTimeMillis,
  emittedTerminalEvent: false,
  eventSequence: 0,
  harness,
  runId: ids.runId,
  turnId: ids.turnId,
});

const withHarnessModel = <State extends HarnessEventState>(
  state: State,
  model: string | null | undefined
): State =>
  model === undefined
    ? state
    : {
        ...state,
        model,
      };

const withHarnessCurrentTime = <State extends HarnessEventState>(
  state: State,
  currentTimeMillis: number
): State => ({
  ...state,
  currentTimeMillis,
});

const markHarnessTerminalEvent = (
  state: HarnessEventState
): HarnessEventState => ({
  ...state,
  emittedTerminalEvent: true,
});

const withHarnessSessionId = <State extends HarnessEventState>(
  state: State,
  sessionId: SessionId
): State => ({
  ...state,
  sessionId,
});

/**
 * Resume numbering after a run's last emitted event. `eventId` is
 * `runId:eventSequence`, so a state rebuilt for an existing run has to start
 * past the ids that run already used or the two collide.
 */
const withHarnessEventSequence = <State extends HarnessEventState>(
  state: State,
  eventSequence: number
): State => ({
  ...state,
  eventSequence,
});

const withHarnessUsage = <State extends HarnessEventState>(
  state: State,
  usage: RuntimeUsage
): State => {
  const previousCost = state.usage?.costUsd;
  // Cost is cumulative across rounds; token fields describe the latest round.
  const costUsd =
    usage.costUsd === undefined
      ? previousCost
      : (previousCost ?? 0) + usage.costUsd;
  return {
    ...state,
    usage: {
      ...usage,
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  };
};

const isRawEvent = (value: unknown): value is AgentRuntimeRawEvent =>
  typeof value === "object" &&
  value !== null &&
  "payload" in value &&
  "source" in value &&
  typeof value.source === "string";

const makeRawEvent = (raw: unknown): AgentRuntimeRawEvent =>
  isRawEvent(raw)
    ? raw
    : {
        payload: raw,
        source: "engine",
      };

const makeRuntimeMetadata = <State extends HarnessEventState>(
  state: State,
  raw?: unknown
): readonly [State, RuntimeEventMetadata] => {
  const eventSequence = state.eventSequence + 1;
  const nextState = {
    ...state,
    eventSequence,
  };
  const metadata: {
    createdAt: string;
    eventId: RuntimeEventId;
    harness: HarnessName;
    model?: string | null;
    raw?: AgentRuntimeRawEvent;
    runId: RunId;
    sessionId?: SessionId;
    turnId: TurnId;
  } = {
    createdAt: new Date(state.currentTimeMillis).toISOString(),
    eventId: RuntimeEventId.make(`${state.runId}:${eventSequence}`),
    harness: state.harness,
    runId: state.runId,
    turnId: state.turnId,
  };

  if (raw !== undefined) {
    metadata.raw = makeRawEvent(raw);
  }
  if (state.model !== undefined) {
    metadata.model = state.model;
  }
  if (state.sessionId) {
    metadata.sessionId = state.sessionId;
  }

  return [nextState, metadata];
};

const makeSessionStartedEvent = <State extends HarnessEventState>(
  state: State,
  sessionId: SessionId,
  raw: unknown
): readonly [State, AgentRuntimeEvent] => {
  const [nextState, metadata] = makeRuntimeMetadata(state, raw);
  return [
    nextState,
    {
      ...metadata,
      payload: {
        sessionId,
      },
      type: AgentRuntimeEventTag.SessionStarted,
    },
  ];
};

interface ToolStartedEventInput {
  readonly name: string;
  readonly input: unknown;
  readonly raw: unknown;
}

const makeToolStartedEvent = <State extends HarnessEventState>(
  state: State,
  input: ToolStartedEventInput
): readonly [State, AgentRuntimeEvent] => {
  const [nextState, metadata] = makeRuntimeMetadata(state, input.raw);
  return [
    nextState,
    {
      ...metadata,
      payload: {
        input: input.input,
        name: input.name,
      },
      type: AgentRuntimeEventTag.ToolStarted,
    },
  ];
};

type TurnCompletedEventInput =
  | {
      readonly ok?: true;
      readonly raw?: unknown;
    }
  | {
      readonly failure: AgentFailure;
      readonly ok: false;
      readonly raw?: unknown;
    };

const makeTurnCompletedEvent = <State extends HarnessEventState>(
  state: State,
  input: TurnCompletedEventInput = {}
): readonly [State, AgentRuntimeEvent] => {
  const [nextState, metadata] = makeRuntimeMetadata(state, input.raw);
  if (input.ok !== false) {
    return [
      nextState,
      {
        ...metadata,
        payload: {
          usage: state.usage,
        },
        type: AgentRuntimeEventTag.TurnSucceeded,
      },
    ];
  }
  return [
    nextState,
    {
      ...metadata,
      payload: {
        failure: input.failure,
        usage: state.usage,
      },
      type: AgentRuntimeEventTag.TurnFailed,
    },
  ];
};

const makeRuntimeErrorEvent = <State extends HarnessEventState>(
  state: State,
  failure: AgentFailure,
  raw: unknown
): readonly [State, AgentRuntimeEvent] => {
  const [nextState, metadata] = makeRuntimeMetadata(state, raw);
  return [
    nextState,
    {
      ...metadata,
      payload: {
        failure,
      },
      type: AgentRuntimeEventTag.RuntimeError,
    },
  ];
};

const makeRuntimeWarningEvent = <State extends HarnessEventState>(
  state: State,
  message: string,
  raw: unknown
): readonly [State, AgentRuntimeEvent] => {
  const [nextState, metadata] = makeRuntimeMetadata(state, raw);
  return [
    nextState,
    {
      ...metadata,
      payload: {
        message,
      },
      type: AgentRuntimeEventTag.RuntimeWarning,
    },
  ];
};

const makeHarnessRuntimeEvent = <State extends HarnessEventState>(
  state: State,
  event: AuthorAgentRuntimeEvent
): readonly [State, AgentRuntimeEvent] => {
  const [nextState, metadata] = makeRuntimeMetadata(state, event.raw);
  return [
    nextState,
    {
      ...event,
      ...metadata,
    },
  ];
};

const makeRunStartedEvent = <State extends HarnessEventState>(
  state: State,
  options: HarnessStartOptions
): readonly [State, AgentRuntimeEvent] => {
  const [nextState, metadata] = makeRuntimeMetadata(state);
  return [
    nextState,
    {
      ...metadata,
      payload: {
        cwd: options.cwd,
        model: options.model,
        prompt: options.prompt,
        userId: options.userId,
      },
      type: AgentRuntimeEventTag.RunStarted,
    },
  ];
};

const makeTurnStartedEvent = <State extends HarnessEventState>(
  state: State,
  prompt: string
): readonly [State, AgentRuntimeEvent] => {
  const [nextState, metadata] = makeRuntimeMetadata(state);
  return [
    nextState,
    {
      ...metadata,
      payload: {
        prompt,
      },
      type: AgentRuntimeEventTag.TurnStarted,
    },
  ];
};

export const makeHarnessStartEvents = <State extends HarnessEventState>(
  state: State,
  options: HarnessStartOptions
): readonly [State, readonly AgentRuntimeEvent[]] => {
  const [runStartedState, runStarted] = makeRunStartedEvent(state, options);
  const [turnStartedState, turnStarted] = makeTurnStartedEvent(
    runStartedState,
    options.prompt
  );
  return [turnStartedState, [runStarted, turnStarted]];
};

export {
  initialHarnessEventState,
  withHarnessModel,
  withHarnessCurrentTime,
  markHarnessTerminalEvent,
  withHarnessEventSequence,
  withHarnessSessionId,
  withHarnessUsage,
  makeSessionStartedEvent,
  makeToolStartedEvent,
  makeTurnCompletedEvent,
  makeRuntimeErrorEvent,
  makeRuntimeWarningEvent,
  makeHarnessRuntimeEvent,
  makeHarnessEventIds,
};
export type {
  HarnessEventState,
  HarnessEventIds,
  ToolStartedEventInput,
  TurnCompletedEventInput,
};
