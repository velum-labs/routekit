import { Effect, Option, Schema } from "effect";

import type {
  AgentInteractionResponse,
  AgentResumeToken,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionEventEnvelope,
  HarnessCompactionOptions,
  HarnessConnectOptions,
  HarnessInvokeOptions,
} from "../../../contracts/author/src/index.ts";
import type { AgentHarness } from "../../../contracts/internal/src/author-schemas/agent-harness.ts";
import type { HarnessError } from "../../../contracts/internal/src/errors.ts";
import type { RuntimeHarnessCompactionOptions } from "./options.ts";

import {
  HarnessCapabilityError,
  HarnessProtocolError,
} from "../../../contracts/internal/src/errors.ts";
import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

import type { OpenedPublicHarness } from "./harness-registration.ts";

import { formatHarnessFailureDetail } from "./harness-error-detail.ts";
import { harvestResumeToken } from "./resume-token-harvest.ts";

export interface LifecycleState {
  readonly contribution: AgentHarness;
  readonly ensureOpened: () => Promise<OpenedPublicHarness>;
  readonly toPublicCompactionOptions: (
    options: RuntimeHarnessCompactionOptions
  ) => HarnessCompactionOptions;
  readonly projectSessionEvents: (
    events: AsyncIterable<AgentSessionEventEnvelope>,
    session: AgentSession,
    claim: number
  ) => AsyncIterable<AgentRuntimeEvent>;
  readonly turnBusy: boolean;
  readonly claimTurn: () => number;
  readonly setTurnBusy: (busy: boolean) => void;
  readonly pendingInteractions: Map<string, number>;
  readonly inFlightInteractions: Set<string>;
  readonly runExclusive: <Result>(
    operation: () => Promise<Result>
  ) => Promise<Result>;
  session: AgentSession | undefined;
  readonly sessionIdentities: Set<string>;
  readonly harvestedResumeTokens: Map<string, AgentResumeToken>;
  opened: Promise<OpenedPublicHarness> | undefined;
}

const protocol = (
  state: LifecycleState,
  operation: string,
  cause: unknown
): HarnessProtocolError =>
  new HarnessProtocolError({
    cause,
    detail: formatHarnessFailureDetail(
      state.contribution.name,
      operation,
      cause
    ),
  });

const cleanupReplacedSession = async (
  session: AgentSession
): Promise<unknown> => {
  const interruptError = await session.interrupt?.().then(
    () => null,
    (error: unknown) => error
  );
  const releaseError = await session.release().then(
    () => null,
    (error: unknown) => error
  );
  return interruptError ?? releaseError ?? undefined;
};

const replaceLiveSession = async (
  state: LifecycleState,
  oldSession: AgentSession
): Promise<void> => {
  const oldIdentities = new Set(state.sessionIdentities);
  state.session = undefined;
  state.sessionIdentities.clear();
  state.pendingInteractions.clear();
  state.inFlightInteractions.clear();
  state.setTurnBusy(false);
  const harvestError = await harvestResumeToken(
    state.harvestedResumeTokens,
    oldSession,
    oldIdentities
  );
  const cleanupError = await cleanupReplacedSession(oldSession);
  const teardownError = harvestError ?? cleanupError;
  if (teardownError !== undefined) {
    throw new Error(formatUnknownError(teardownError), {
      cause: teardownError,
    });
  }
};

const promptSession = (
  state: LifecycleState,
  session: AgentSession,
  options: HarnessConnectOptions
): Promise<AsyncIterable<AgentSessionEventEnvelope>> =>
  Promise.resolve()
    .then(() => session.prompt(options))
    .catch((error: unknown) => {
      state.setTurnBusy(false);
      throw error;
    });

const promptOnSession = async (
  state: LifecycleState,
  session: AgentSession,
  options: HarnessConnectOptions
): Promise<AsyncIterable<AgentRuntimeEvent>> => {
  if (options.sessionId !== undefined) {
    state.sessionIdentities.add(options.sessionId);
  }
  const claim = state.claimTurn();
  return state.projectSessionEvents(
    await promptSession(state, session, options),
    session,
    claim
  );
};

export const makeInitialize = (
  state: LifecycleState
): Effect.Effect<void, HarnessError> =>
  Effect.tryPromise({
    catch: (cause) => protocol(state, "failed to initialize", cause),
    try: async () => {
      await state.runExclusive(() => state.ensureOpened());
    },
  });

export const makeMode = (
  state: LifecycleState
): Effect.Effect<"connect" | "prompt", HarnessError> =>
  Effect.tryPromise({
    catch: (cause) => protocol(state, "failed to inspect registration", cause),
    try: async () => {
      const runtime = await state.runExclusive(() => state.ensureOpened());
      return runtime.connect === undefined ? "prompt" : "connect";
    },
  });

export const makeProbe = (
  state: LifecycleState
): Effect.Effect<string | undefined, HarnessError> =>
  Effect.tryPromise({
    catch: (cause) => protocol(state, "failed to probe availability", cause),
    try: async () => {
      const runtime = await state.runExclusive(() => state.ensureOpened());
      return runtime.probe === undefined ? undefined : await runtime.probe();
    },
  });

export const makeClose = (
  state: LifecycleState
): Effect.Effect<void, HarnessError> =>
  Effect.tryPromise({
    catch: (cause) => protocol(state, "failed to close", cause),
    try: () =>
      state.runExclusive(async () => {
        const current = state.opened;
        state.opened = undefined;
        const { session } = state;
        state.session = undefined;
        state.sessionIdentities.clear();
        state.harvestedResumeTokens.clear();
        state.setTurnBusy(false);
        state.pendingInteractions.clear();
        state.inFlightInteractions.clear();
        const results = await Promise.allSettled([
          session?.release() ?? Promise.resolve(),
          current === undefined
            ? Promise.resolve()
            : current.then((runtime) => runtime.close?.() ?? Promise.resolve()),
        ]);
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        );
        if (failure !== undefined) {
          throw failure.reason instanceof Error
            ? failure.reason
            : new Error(formatUnknownError(failure.reason));
        }
      }),
  });

export const makeInterrupt = (
  state: LifecycleState
): Effect.Effect<void, HarnessError> =>
  Effect.tryPromise({
    catch: (cause) => protocol(state, "failed to interrupt", cause),
    try: () =>
      state.runExclusive(async () => {
        const { session } = state;
        if (session === undefined) {
          return;
        }
        if (session.interrupt === undefined) {
          const identities = new Set(state.sessionIdentities);
          state.session = undefined;
          state.sessionIdentities.clear();
          state.setTurnBusy(false);
          state.pendingInteractions.clear();
          state.inFlightInteractions.clear();
          const harvestError = await harvestResumeToken(
            state.harvestedResumeTokens,
            session,
            identities
          );
          await session.release();
          if (harvestError !== undefined) {
            throw new Error(formatUnknownError(harvestError), {
              cause: harvestError,
            });
          }
          return;
        }
        // A wedged provider is exactly when interrupt is used, so a failed
        // interrupt still releases the turn bookkeeping before surfacing.
        const interruptError = await session.interrupt().then(
          () => null,
          (error: unknown) => error
        );
        state.setTurnBusy(false);
        state.pendingInteractions.clear();
        state.inFlightInteractions.clear();
        if (interruptError !== null) {
          throw new Error(formatUnknownError(interruptError), {
            cause: interruptError,
          });
        }
      }),
  });

export const makeCompact = (
  state: LifecycleState
): Effect.Effect<
  Option.Option<
    (
      options: RuntimeHarnessCompactionOptions
    ) => AsyncIterable<AgentRuntimeEvent>
  >,
  HarnessError
> =>
  Effect.tryPromise({
    catch: (cause) => protocol(state, "failed to inspect compaction", cause),
    try: async () => {
      const runtime = await state.runExclusive(() => state.ensureOpened());
      const { compact } = runtime;
      return compact === undefined
        ? Option.none()
        : Option.some((options) =>
            compact(state.toPublicCompactionOptions(options))
          );
    },
  });

export const makePrompt = (
  state: LifecycleState,
  options: HarnessInvokeOptions
): Effect.Effect<AsyncIterable<AgentRuntimeEvent>, HarnessError> =>
  Effect.tryPromise({
    catch: (cause) => protocol(state, "failed to start", cause),
    try: async () => {
      const runtime = await state.runExclusive(() => state.ensureOpened());
      const { prompt } = runtime;
      if (prompt === undefined) {
        throw new Error(
          `Harness "${state.contribution.name}" did not register a prompt callback`
        );
      }
      return prompt(options);
    },
  });

export const makeConnect = (
  state: LifecycleState,
  options: HarnessConnectOptions
): Effect.Effect<AsyncIterable<AgentRuntimeEvent>, HarnessError> =>
  Effect.tryPromise({
    catch: (cause) =>
      Schema.is(HarnessCapabilityError)(cause)
        ? cause
        : protocol(state, "failed to connect", cause),
    try: () =>
      state.runExclusive(async () => {
        const runtime = await state.ensureOpened();
        const { connect } = runtime;
        if (connect === undefined) {
          throw new Error(
            `Harness "${state.contribution.name}" did not register a connect callback`
          );
        }
        if (state.turnBusy) {
          throw new HarnessProtocolError({
            detail: `Harness "${state.contribution.name}" already has an active turn`,
          });
        }
        // A caller naming the live conversation reuses it, and the builtin
        // reconnects internally when it cannot apply a per-turn option. An
        // anonymous call is a new conversation and never inherits history.
        const namesLiveSession =
          options.sessionId !== undefined &&
          state.sessionIdentities.has(options.sessionId);
        if (state.session !== undefined && namesLiveSession) {
          return await promptOnSession(state, state.session, options);
        }
        if (state.session !== undefined) {
          await replaceLiveSession(state, state.session);
        }
        const harvestedToken =
          options.sessionId === undefined
            ? undefined
            : state.harvestedResumeTokens.get(options.sessionId);
        const resumeToken = options.resumeToken ?? harvestedToken;
        const session = await connect(
          resumeToken === options.resumeToken
            ? options
            : {
                ...options,
                resumeToken,
              }
        );
        state.session = session;
        state.sessionIdentities.clear();
        state.sessionIdentities.add(session.id);
        return await promptOnSession(state, session, options);
      }),
  });

export const makeRespond = (
  state: LifecycleState,
  response: AgentInteractionResponse
): Effect.Effect<void, HarnessError> =>
  Effect.tryPromise({
    catch: (cause) =>
      Schema.is(HarnessCapabilityError)(cause)
        ? cause
        : protocol(state, "failed to respond to interaction", cause),
    try: () =>
      state.runExclusive(async () => {
        if (state.session?.respond === undefined) {
          throw new HarnessCapabilityError({
            capability: "respond",
            detail: `Harness "${state.contribution.name}" registered no interaction responder`,
          });
        }
        const turnId = state.pendingInteractions.get(response.correlationId);
        if (turnId === undefined) {
          throw new Error(
            `Harness "${state.contribution.name}" has no outstanding interaction "${response.correlationId}"`
          );
        }
        if (state.inFlightInteractions.has(response.correlationId)) {
          throw new Error(
            `Harness "${state.contribution.name}" is already responding to interaction "${response.correlationId}"`
          );
        }
        state.pendingInteractions.delete(response.correlationId);
        state.inFlightInteractions.add(response.correlationId);
        const result = await state.session.respond(response).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({
            error,
            ok: false as const,
          })
        );
        state.inFlightInteractions.delete(response.correlationId);
        if (!result.ok) {
          state.pendingInteractions.set(response.correlationId, turnId);
          throw result.error;
        }
      }),
  });
