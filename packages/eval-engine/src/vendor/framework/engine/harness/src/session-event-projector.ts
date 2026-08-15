import { Result } from "effect";

import type { AgentRuntimeEvent, AgentSession } from "../../../contracts/author/src/index.ts";

import { HarnessCapabilityError } from "../../../contracts/internal/src/errors.ts";

import { projectSessionEvent } from "./session-event-projection.ts";

export interface SessionProjectorInput {
  readonly pendingInteractions: Map<string, number>;
  readonly beginTurn: (claim: number) => number | undefined;
  readonly finishTurn: (turnId: number) => void;
  readonly inFlightInteractions: Set<string>;
  readonly isSessionCurrent: (session: object) => boolean;
  readonly isCurrent: (session: object, turnId: number) => boolean;
  readonly releaseBusy: (claim: number) => void;
}

// A blocking request nobody can answer is a silent hang, so it fails the turn
// at the moment it is raised (RFC 0005) rather than waiting on a response that
// can never arrive.
const registerInteraction = async (
  input: SessionProjectorInput,
  request: {
    readonly correlationId: string;
    readonly finish: () => void;
    readonly iterator: AsyncIterator<unknown>;
    readonly session: AgentSession;
    readonly turnId: number;
  }
): Promise<void> => {
  if (request.session.respond === undefined) {
    request.finish();
    await request.iterator.return?.();
    throw new HarnessCapabilityError({
      capability: "respond",
      detail:
        "The provider raised a blocking interaction request but the session registered no responder",
    });
  }
  if (input.isCurrent(request.session, request.turnId)) {
    input.pendingInteractions.set(request.correlationId, request.turnId);
  }
};

// A JS provider can yield any value; `in` on a non-object would throw past
// the turn bookkeeping, so the probe narrows before it looks.
const interactionCorrelationId = (value: unknown): string | undefined =>
  typeof value === "object" &&
  value !== null &&
  "correlationId" in value &&
  typeof value.correlationId === "string"
    ? value.correlationId
    : undefined;

const failReplacedSession = async (
  iterator: AsyncIterator<unknown>
): Promise<never> => {
  await iterator.return?.();
  throw new Error("The provider session was replaced before this turn started");
};

// Projection throws synchronously on an unsupported discriminant, so the
// failure must release the turn slot before it propagates.
const projectOrRelease = (
  finish: () => void,
  value: Parameters<typeof projectSessionEvent>[0]
): IteratorResult<AgentRuntimeEvent> => {
  const projected = Result.try({
    catch: (error: unknown) => error,
    try: () => projectSessionEvent(value),
  });
  if (Result.isFailure(projected)) {
    finish();
    throw projected.failure;
  }
  return {
    done: false,
    value: projected.success,
  };
};

const makeProjectedIterator = (
  input: SessionProjectorInput,
  iterator: AsyncIterator<Parameters<typeof projectSessionEvent>[0]>,
  turn: { readonly session: AgentSession; readonly claim: number }
): AsyncIterator<AgentRuntimeEvent> => {
  const { session, claim } = turn;
  let started = false;
  let turnId: number | undefined;
  const finish = (): void => {
    // The lifecycle marks the turn busy before the first event is pulled, so
    // abandoning the stream before a turn id exists must release its own
    // claim; the claim keeps a stale stream from freeing a newer turn's slot.
    if (turnId === undefined) {
      input.releaseBusy(claim);
      return;
    }
    if (input.isCurrent(session, turnId)) {
      input.finishTurn(turnId);
      input.inFlightInteractions.clear();
    }
  };
  return {
    next: async (): Promise<IteratorResult<AgentRuntimeEvent>> => {
      if (!started) {
        if (!input.isSessionCurrent(session)) {
          return await failReplacedSession(iterator);
        }
        started = true;
        turnId = input.beginTurn(claim);
      }
      if (turnId === undefined || !input.isCurrent(session, turnId)) {
        return await failReplacedSession(iterator);
      }
      const result = await iterator.next().catch((error: unknown) => {
        finish();
        throw error;
      });
      const correlationId = result.done
        ? undefined
        : interactionCorrelationId(result.value);
      if (correlationId !== undefined) {
        await registerInteraction(input, {
          correlationId,
          finish,
          iterator,
          session,
          turnId,
        });
      }
      if (result.done) {
        finish();
        return result;
      }
      return projectOrRelease(finish, result.value);
    },
    return: (): Promise<IteratorResult<AgentRuntimeEvent>> => {
      finish();
      return Promise.resolve(iterator.return?.()).then(() => ({
        done: true as const,
        value: undefined,
      }));
    },
  };
};

export const makeSessionEventProjector =
  (input: SessionProjectorInput) =>
  (
    events: AsyncIterable<Parameters<typeof projectSessionEvent>[0]>,
    session: AgentSession,
    claim: number
  ): AsyncIterable<AgentRuntimeEvent> => ({
    [Symbol.asyncIterator]: (): AsyncIterator<AgentRuntimeEvent> =>
      makeProjectedIterator(input, events[Symbol.asyncIterator](), {
        claim,
        session,
      }),
  });
