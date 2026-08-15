import type { Effect, Option } from "effect";

import { Schema } from "effect";

import type {
  AgentInteractionResponse,
  AgentResumeToken,
  AgentRuntimeEvent as AgentRuntimeEventContribution,
  AgentSession,
  HarnessCompactionOptions,
  HarnessConnectOptions,
  HarnessInvokeOptions,
} from "../../../contracts/author/src/index.ts";
import type { AgentHarness } from "../../../contracts/internal/src/author-schemas/agent-harness.ts";
import type { HarnessError } from "../../../contracts/internal/src/errors.ts";
import type { RuntimeHarnessCompactionOptions } from "./options.ts";

import { HarnessInvokeOptionsSchema } from "../../../contracts/internal/src/author-schemas/harness-options.ts";

import type { OpenedPublicHarness } from "./harness-registration.ts";
import type { LifecycleState } from "./lifecycle-operations.ts";

import { openPublicHarness } from "./harness-registration.ts";
import {
  makeClose,
  makeCompact,
  makeConnect,
  makeInitialize,
  makeInterrupt,
  makeMode,
  makeProbe,
  makePrompt,
  makeRespond,
} from "./lifecycle-operations.ts";
import { makeSessionEventProjector } from "./session-event-projector.ts";

export { formatHarnessFailureDetail } from "./harness-error-detail.ts";

const makeEnsureOpened =
  (input: {
    readonly contribution: AgentHarness;
    readonly onDefaultModel: (model: string | undefined) => void;
    readonly getOpened: () => Promise<OpenedPublicHarness> | undefined;
    readonly setOpened: (
      opened: Promise<OpenedPublicHarness> | undefined
    ) => void;
  }): (() => Promise<OpenedPublicHarness>) =>
  async () => {
    const pending =
      input.getOpened() ??
      openPublicHarness(input.contribution, input.onDefaultModel);
    input.setOpened(pending);
    try {
      return await pending;
    } catch (error) {
      input.setOpened(undefined);
      throw error;
    }
  };

const makeLifecycleEnsureOpened = (input: {
  readonly contribution: AgentHarness;
  readonly setDefaultModel: (model: string | undefined) => void;
  readonly opened: {
    readonly get: () => Promise<OpenedPublicHarness> | undefined;
    readonly set: (value: Promise<OpenedPublicHarness> | undefined) => void;
  };
}): (() => Promise<OpenedPublicHarness>) =>
  makeEnsureOpened({
    contribution: input.contribution,
    onDefaultModel: input.setDefaultModel,
    getOpened: input.opened.get,
    setOpened: input.opened.set,
  });

const toPublicCompactionOptions = (
  options: RuntimeHarnessCompactionOptions
): HarnessCompactionOptions => {
  const encoded = Schema.encodeSync(HarnessInvokeOptionsSchema)({
    ...options,
    outputSchema: undefined,
    prompt: "",
  });
  const {
    prompt: _prompt,
    outputSchema: _outputSchema,
    ...publicOptions
  } = encoded;
  return publicOptions;
};

const makeOperationQueue = (): (<Result>(
  operation: () => Promise<Result>
) => Promise<Result>) => {
  let operationTail = Promise.resolve(null);
  return <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const previous = operationTail;
    const gate = Promise.withResolvers<null>();
    operationTail = gate.promise;
    return previous.then(operation).finally(() => {
      gate.resolve(null);
    });
  };
};

const makeProjectSessionEvents = (input: {
  readonly pendingInteractions: Map<string, number>;
  readonly inFlightInteractions: Set<string>;
  readonly turnCoordinator: ReturnType<typeof makeTurnCoordinator>;
  readonly getSession: () => AgentSession | undefined;
  readonly isSessionCurrent: (session: object) => boolean;
}): LifecycleState["projectSessionEvents"] =>
  makeSessionEventProjector({
    inFlightInteractions: input.inFlightInteractions,
    beginTurn: input.turnCoordinator.beginTurn,
    finishTurn: input.turnCoordinator.finishTurn,
    pendingInteractions: input.pendingInteractions,
    isSessionCurrent: input.isSessionCurrent,
    releaseBusy: input.turnCoordinator.releaseBusy,
    isCurrent: (session, turnId) =>
      input.getSession() === session && input.turnCoordinator.isCurrent(turnId),
  });

const makeTurnCoordinator = (
  pendingInteractions: Map<string, number>
): {
  readonly beginTurn: (claim: number) => number | undefined;
  readonly claimBusy: () => number;
  readonly finishTurn: (turnId: number) => void;
  readonly isCurrent: (turnId: number) => boolean;
  readonly isBusy: () => boolean;
  readonly releaseBusy: (claim: number) => void;
  readonly reset: () => void;
} => {
  let nextTurnId = 0;
  let activeTurnId: number | undefined;
  let busyEpoch = 0;
  let turnBusy = false;
  return {
    beginTurn: (claim: number): number | undefined => {
      if (claim !== busyEpoch || activeTurnId !== undefined) {
        return undefined;
      }
      nextTurnId += 1;
      activeTurnId = nextTurnId;
      turnBusy = true;
      return activeTurnId;
    },
    claimBusy: (): number => {
      busyEpoch += 1;
      turnBusy = true;
      return busyEpoch;
    },
    finishTurn: (turnId: number): void => {
      if (activeTurnId !== turnId) {
        return;
      }
      activeTurnId = undefined;
      turnBusy = false;
      for (const [correlationId, pendingTurnId] of pendingInteractions) {
        if (pendingTurnId === turnId) {
          pendingInteractions.delete(correlationId);
        }
      }
    },
    isCurrent: (turnId): boolean => activeTurnId === turnId,
    isBusy: (): boolean => turnBusy,
    // A claim releases only the busy flag it set itself: a newer claim or an
    // already-begun turn keeps the flag, so an abandoned stale stream can
    // never free a slot another turn is holding.
    releaseBusy: (claim: number): void => {
      if (claim === busyEpoch && activeTurnId === undefined) {
        turnBusy = false;
      }
    },
    reset: (): void => {
      activeTurnId = undefined;
      busyEpoch += 1;
      turnBusy = false;
    },
  };
};

export interface PublicHarnessLifecycle {
  readonly initialize: Effect.Effect<void, HarnessError>;
  readonly defaultModel: () => string | undefined;
  readonly sessionId: () => string | undefined;
  readonly mode: Effect.Effect<"connect" | "prompt", HarnessError>;
  readonly probe: Effect.Effect<string | undefined, HarnessError>;
  readonly close: Effect.Effect<void, HarnessError>;
  readonly interrupt: Effect.Effect<void, HarnessError>;
  readonly compact: Effect.Effect<
    Option.Option<
      (
        options: RuntimeHarnessCompactionOptions
      ) => AsyncIterable<AgentRuntimeEventContribution>
    >,
    HarnessError
  >;
  readonly prompt: (
    options: HarnessInvokeOptions
  ) => Effect.Effect<
    AsyncIterable<AgentRuntimeEventContribution>,
    HarnessError
  >;
  readonly connect: (
    options: HarnessConnectOptions
  ) => Effect.Effect<
    AsyncIterable<AgentRuntimeEventContribution>,
    HarnessError
  >;
  readonly respond: (
    response: AgentInteractionResponse
  ) => Effect.Effect<void, HarnessError>;
}

const makePublicLifecycle = (
  state: LifecycleState,
  defaultModel: () => string | undefined
): PublicHarnessLifecycle => ({
  initialize: makeInitialize(state),
  defaultModel,
  sessionId: (): string | undefined => state.session?.id,
  mode: makeMode(state),
  probe: makeProbe(state),
  close: makeClose(state),
  interrupt: makeInterrupt(state),
  compact: makeCompact(state),
  prompt: (options): ReturnType<PublicHarnessLifecycle["prompt"]> =>
    makePrompt(state, options),
  connect: (options): ReturnType<PublicHarnessLifecycle["connect"]> =>
    makeConnect(state, options),
  respond: (response): ReturnType<PublicHarnessLifecycle["respond"]> =>
    makeRespond(state, response),
});

export const makePublicHarnessLifecycle = (
  contribution: AgentHarness
): PublicHarnessLifecycle => {
  let opened: Promise<OpenedPublicHarness> | undefined;
  let registeredDefaultModel: string | undefined;
  const pendingInteractions = new Map<string, number>();
  const inFlightInteractions = new Set<string>();
  const turnCoordinator = makeTurnCoordinator(pendingInteractions);
  let currentSession: AgentSession | undefined;
  const projectSessionEvents = makeProjectSessionEvents({
    pendingInteractions,
    inFlightInteractions,
    turnCoordinator,
    getSession: () => currentSession,
    isSessionCurrent: (session) => currentSession === session,
  });
  const ensureOpened = makeLifecycleEnsureOpened({
    contribution,
    setDefaultModel: (model) => {
      registeredDefaultModel = model;
    },
    opened: {
      get: () => opened,
      set: (value) => {
        opened = value;
      },
    },
  });
  const state: LifecycleState = {
    contribution,
    ensureOpened,
    get opened() {
      return opened;
    },
    set opened(value) {
      opened = value;
    },
    projectSessionEvents,
    get turnBusy() {
      return turnCoordinator.isBusy();
    },
    claimTurn: turnCoordinator.claimBusy,
    setTurnBusy: (busy) => {
      if (busy) {
        turnCoordinator.claimBusy();
      } else {
        turnCoordinator.reset();
      }
    },
    pendingInteractions,
    inFlightInteractions,
    sessionIdentities: new Set<string>(),
    harvestedResumeTokens: new Map<string, AgentResumeToken>(),
    get session(): AgentSession | undefined {
      return currentSession;
    },
    set session(value: AgentSession | undefined) {
      currentSession = value;
    },
    runExclusive: makeOperationQueue(),
    toPublicCompactionOptions,
  };
  return makePublicLifecycle(state, () => registeredDefaultModel);
};
