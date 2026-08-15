import { Schema, Stream } from "effect";

import type { RuntimeUsage } from "../../../../contracts/author/src/index.ts";
import type { AgentRuntimeEvent } from "../../../../contracts/internal/src/runtime/agent-runtime-event-types.ts";

import { AgentRuntimeEventTag } from "../../../../contracts/author/src/index.ts";
import {
  RuntimeUsageItemType,
  RuntimeUsageReport,
} from "../../../../contracts/internal/src/runtime/agent-session-item.ts";

type UsageTerminalEvent = Extract<
  AgentRuntimeEvent,
  {
    readonly type:
      | typeof AgentRuntimeEventTag.SessionFailed
      | typeof AgentRuntimeEventTag.SessionSucceeded
      | typeof AgentRuntimeEventTag.TurnFailed
      | typeof AgentRuntimeEventTag.TurnSucceeded;
  }
>;

type TurnTerminalEvent = Extract<
  UsageTerminalEvent,
  {
    readonly type:
      | typeof AgentRuntimeEventTag.TurnFailed
      | typeof AgentRuntimeEventTag.TurnSucceeded;
  }
>;

const isUsageTerminalEvent = (
  event: AgentRuntimeEvent
): event is UsageTerminalEvent =>
  event.type === AgentRuntimeEventTag.SessionFailed ||
  event.type === AgentRuntimeEventTag.SessionSucceeded ||
  event.type === AgentRuntimeEventTag.TurnFailed ||
  event.type === AgentRuntimeEventTag.TurnSucceeded;

const isTurnTerminalEvent = (
  event: AgentRuntimeEvent
): event is TurnTerminalEvent =>
  event.type === AgentRuntimeEventTag.TurnFailed ||
  event.type === AgentRuntimeEventTag.TurnSucceeded;

const hasPositiveCost = (costUsd: number | undefined): boolean =>
  costUsd !== undefined && costUsd > 0;

const usageWithoutCost = (usage: RuntimeUsage): RuntimeUsage => ({
  cacheCreationTokens: usage.cacheCreationTokens,
  cacheReadTokens: usage.cacheReadTokens,
  ...(usage.contextTokens === undefined
    ? {}
    : { contextTokens: usage.contextTokens }),
  inputTokens: usage.inputTokens,
  ...(usage.model === undefined ? {} : { model: usage.model }),
  ...(usage.generationId === undefined
    ? {}
    : { generationId: usage.generationId }),
  outputTokens: usage.outputTokens,
});

const usageUpdateRuntimeUsage = (
  event: AgentRuntimeEvent
): RuntimeUsage | undefined => {
  if (
    event.type !== AgentRuntimeEventTag.ItemCompleted ||
    event.payload.itemType !== RuntimeUsageItemType ||
    !Schema.is(RuntimeUsageReport)(event.payload.data)
  ) {
    return undefined;
  }
  return event.payload.data.usage;
};

const withTerminalCost = (
  event: TurnTerminalEvent,
  costUsd: number
): TurnTerminalEvent => {
  const usage =
    event.payload.usage === undefined
      ? undefined
      : {
          ...event.payload.usage,
          costUsd,
        };
  switch (event.type) {
    case AgentRuntimeEventTag.TurnFailed: {
      return {
        ...event,
        payload: {
          ...event.payload,
          usage,
        },
      };
    }
    case AgentRuntimeEventTag.TurnSucceeded: {
      return {
        ...event,
        payload: {
          ...event.payload,
          usage,
        },
      };
    }
    default: {
      return event;
    }
  }
};

const withoutTerminalCost = (event: UsageTerminalEvent): UsageTerminalEvent => {
  const usage =
    event.payload.usage === undefined
      ? undefined
      : usageWithoutCost(event.payload.usage);
  switch (event.type) {
    case AgentRuntimeEventTag.SessionFailed: {
      return {
        ...event,
        payload: {
          ...event.payload,
          usage,
        },
      };
    }
    case AgentRuntimeEventTag.SessionSucceeded: {
      return {
        ...event,
        payload: {
          ...event.payload,
          usage,
        },
      };
    }
    case AgentRuntimeEventTag.TurnFailed: {
      return {
        ...event,
        payload: {
          ...event.payload,
          usage,
        },
      };
    }
    case AgentRuntimeEventTag.TurnSucceeded: {
      return {
        ...event,
        payload: {
          ...event.payload,
          usage,
        },
      };
    }
    default: {
      return event;
    }
  }
};

type Round = Readonly<{
  providerCost: number | undefined;
  generationId: string | undefined;
}>;

type UsagePricingState = ReadonlyMap<string, readonly Round[]>;

const appendRound = (
  rounds: readonly Round[],
  runtimeUsage: RuntimeUsage
): readonly Round[] => {
  if (
    runtimeUsage.generationId !== undefined &&
    rounds.some((round) => round.generationId === runtimeUsage.generationId)
  ) {
    return rounds;
  }
  return [
    ...rounds,
    {
      providerCost: runtimeUsage.costUsd,
      generationId: runtimeUsage.generationId,
    },
  ];
};

const usageStateKey = (event: AgentRuntimeEvent): string =>
  `${event.runId}:${event.turnId ?? "run"}`;

const resolveRounds = (rounds: readonly Round[]): number | undefined => {
  const costs = rounds.map((round) =>
    hasPositiveCost(round.providerCost) ? round.providerCost : undefined
  );
  return costs.every((cost) => cost !== undefined)
    ? costs.reduce((total, cost) => total + (cost ?? 0), 0)
    : undefined;
};

const resolveTerminalCost = (
  event: TurnTerminalEvent,
  costUsd: number | undefined
): UsageTerminalEvent => {
  if (costUsd !== undefined) {
    return withTerminalCost(event, costUsd);
  }
  return hasPositiveCost(event.payload.usage?.costUsd)
    ? event
    : withoutTerminalCost(event);
};

const finishTerminal = (
  state: UsagePricingState,
  event: UsageTerminalEvent
): readonly [UsagePricingState, readonly [AgentRuntimeEvent]] => {
  const key = usageStateKey(event);
  const nextState = new Map(state);
  nextState.delete(key);
  if (!isTurnTerminalEvent(event)) {
    return [
      nextState,
      [
        hasPositiveCost(event.payload.usage?.costUsd)
          ? event
          : withoutTerminalCost(event),
      ],
    ] as const;
  }

  const rounds = state.get(key);
  let terminalRounds = rounds;
  if (terminalRounds === undefined && event.payload.usage !== undefined) {
    terminalRounds = [
      {
        providerCost: event.payload.usage.costUsd,
        generationId: event.payload.usage.generationId,
      },
    ];
  }
  terminalRounds ??= [];
  return [
    nextState,
    [resolveTerminalCost(event, resolveRounds(terminalRounds))],
  ];
};

const processUsageEvent = (
  state: UsagePricingState,
  event: AgentRuntimeEvent
): readonly [UsagePricingState, readonly [AgentRuntimeEvent]] => {
  const runtimeUsage = usageUpdateRuntimeUsage(event);
  if (runtimeUsage !== undefined) {
    const key = usageStateKey(event);
    const rounds = state.get(key) ?? [];
    return [
      new Map([...state, [key, appendRound(rounds, runtimeUsage)]]),
      [event],
    ];
  }
  if (isUsageTerminalEvent(event)) {
    return finishTerminal(state, event);
  }
  return [state, [event]];
};

export const mapTurnUsageCost = <E, R>(
  events: Stream.Stream<AgentRuntimeEvent, E, R>
): Stream.Stream<AgentRuntimeEvent, E, R> =>
  Stream.mapAccum(
    events,
    () => new Map() as UsagePricingState,
    processUsageEvent
  );
