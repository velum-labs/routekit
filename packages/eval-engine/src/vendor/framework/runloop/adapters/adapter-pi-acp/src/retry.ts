import {
  Context,
  Duration,
  Effect,
  Layer,
  LayerMap,
  Ref,
  Scope,
  Stream,
} from "effect";

import type {
  SelectedAdapterContribution,
  SelectedAdapterEvent,
  SelectedAdapterOptions,
} from "../../../../engine/selected-adapter/src/inventory.ts";

import { AgentRuntimeEventTag } from "../../../../contracts/author/src/agent-event.ts";
import { agentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import {
  SelectedAdapter,
  SelectedAdapterError,
} from "../../../../engine/selected-adapter/src/inventory.ts";

const MAX_CLAMP_RETRIES = 3;
const RETIRED_PEER_TTL = Duration.minutes(1);
type RetryResources = LayerMap.LayerMap<
  number,
  SelectedAdapter,
  SelectedAdapterError
>;
interface PiRetrySupport {
  readonly affordableMaxTokens: (detail: string) => number | undefined;
  /** Writes the clamped cap and returns the figure it wrote. */
  readonly applyAffordableCap: (
    env: NodeJS.ProcessEnv,
    modelId: string,
    affordable: number
  ) => Promise<number>;
  readonly describeCreditShortfall: (detail: string) => string | undefined;
  readonly resolveModelId: (
    requested: string | null | undefined,
    env: NodeJS.ProcessEnv
  ) => string;
}

// Restate an exhausted credit rejection as a budget failure. Untouched the
// detail reads `Pi rejected the request (-32003): 402 This request requires...`,
// which buries "out of credits" two layers down and echoes the 402 body verbatim
// (see `describeCreditShortfall` on why that body must not be journalled).
const creditShortfallError = (
  support: PiRetrySupport,
  error: SelectedAdapterError
): SelectedAdapterError => {
  const described = support.describeCreditShortfall(error.detail);
  return described === undefined
    ? error
    : new SelectedAdapterError({
        detail: described,
        reason: error.reason,
        safeFailure: agentFailure({
          code: "ORI_OPENROUTER_CREDITS_EXHAUSTED",
          message: described,
          stage: "adapter",
        }),
      });
};

const currentAdapter = (
  generation: Ref.Ref<number>,
  resources: RetryResources,
  scope: Scope.Scope
): Effect.Effect<SelectedAdapter["Service"], SelectedAdapterError> =>
  Ref.get(generation).pipe(
    Effect.flatMap((current) => resources.contextEffect(current)),
    Effect.map((context) => Context.get(context, SelectedAdapter)),
    Effect.provideService(Scope.Scope, scope)
  );

const reattachSession = (
  adapter: Ref.Ref<SelectedAdapter["Service"]>,
  sessionId: string
): Effect.Effect<void, SelectedAdapterError> =>
  Ref.get(adapter).pipe(
    Effect.flatMap((current) =>
      (current.resumeSession ?? current.loadSession)(sessionId)
    )
  );

const environmentFor = (
  options: SelectedAdapterOptions
): NodeJS.ProcessEnv => ({
  ...globalThis.process.env,
  ...options.env,
});

interface PromptInput {
  readonly prompt: string;
  readonly sessionId: string;
}

interface RetryContext {
  readonly adapter: Ref.Ref<SelectedAdapter["Service"]>;
  readonly env: NodeJS.ProcessEnv;
  readonly generation: Ref.Ref<number>;
  readonly modelId: string;
  readonly resources: RetryResources;
  readonly scope: Scope.Scope;
  readonly support: PiRetrySupport;
}

// The boundary between an abandoned attempt and its replacement.
//
// The retried turn RE-RUNS, it does not continue: pi persists the failed turn
// with a `stopReason: "error"` assistant tail, `session/resume` records that as
// a retry entry, and the matching re-prompt forks pi's history back past the
// failure before sending again (the pi ACP adapter's `rollbackFailedPrompt`).
// pi discards its own partial, but ori has already streamed that output, so
// without a marker a consumer just sees the answer begin twice with nothing
// saying the first block was abandoned. `retry.scheduled` is the vocabulary the
// rest of the runtime already uses for exactly this, and the TUI already renders
// it, so the clamp path emits it rather than retrying silently.
const clampRetryScheduled = (
  attempt: number,
  maxTokens: number
): SelectedAdapterEvent => ({
  event: {
    payload: {
      attempt: attempt + 1,
      maxAttempts: MAX_CLAMP_RETRIES,
      message: `OpenRouter credit limit reached; retrying with max_tokens<=${maxTokens}. Output from the abandoned attempt precedes this line.`,
    },
    type: AgentRuntimeEventTag.RetryScheduled,
  },
  type: "runtime-event",
});

// Retire the rejected peer and stand up a replacement under a `maxTokens` the
// balance affords, then reattach the live session with `session/resume`.
// Yields the cap that was written, for the retry marker.
const replacePeerUnderCap = Effect.fn("PiRetry.replacePeerUnderCap")(function* (
  input: RetryContext,
  sessionId: string,
  afford: number
) {
  const maxTokens = yield* Effect.promise(() =>
    input.support.applyAffordableCap(input.env, input.modelId, afford)
  );
  const previous = yield* Ref.getAndUpdate(
    input.generation,
    (current) => current + 1
  );
  yield* input.resources.invalidate(previous);
  const replacement = yield* currentAdapter(
    input.generation,
    input.resources,
    input.scope
  );
  yield* Ref.set(input.adapter, replacement);
  yield* replacement.initialize;
  yield* reattachSession(input.adapter, sessionId);
  return maxTokens;
});

const makeRetryingPrompt = (input: RetryContext) => {
  // A clampable 402 aborts the whole turn, so a mid-turn rejection is retried
  // exactly like a pre-output one. Not retrying it is what lost a 25-minute
  // headless run outright (ORI-882): the turn's work is already forfeit, so
  // replaying it under budget can only improve on it.
  const run = (
    prompt: PromptInput,
    attempt: number
  ): Stream.Stream<SelectedAdapterEvent, SelectedAdapterError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const adapter = yield* Ref.get(input.adapter);
        return adapter.prompt(prompt).pipe(
          Stream.catch((error) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const afford = input.support.affordableMaxTokens(error.detail);
                if (afford === undefined) {
                  return Stream.fail(error);
                }
                if (attempt >= MAX_CLAMP_RETRIES) {
                  return Stream.fail(
                    creditShortfallError(input.support, error)
                  );
                }
                const applied = yield* replacePeerUnderCap(
                  input,
                  prompt.sessionId,
                  afford
                );
                return Stream.make(clampRetryScheduled(attempt, applied)).pipe(
                  Stream.concat(run(prompt, attempt + 1))
                );
              })
            )
          )
        );
      })
    );
  return (
    prompt: PromptInput
  ): Stream.Stream<SelectedAdapterEvent, SelectedAdapterError> =>
    run(prompt, 0);
};

const makeRetryingSelectedAdapterService = (input: {
  readonly adapter: Ref.Ref<SelectedAdapter["Service"]>;
  readonly env: NodeJS.ProcessEnv;
  readonly generation: Ref.Ref<number>;
  readonly modelId: string;
  readonly resources: RetryResources;
  readonly scope: Scope.Scope;
  readonly support: PiRetrySupport;
}): SelectedAdapter["Service"] => {
  const retryPrompt = makeRetryingPrompt(input);
  return SelectedAdapter.of({
    cancel: Ref.get(input.adapter).pipe(
      Effect.flatMap((current) => current.cancel)
    ),
    createSession: (session) =>
      Ref.get(input.adapter).pipe(
        Effect.flatMap((current) => current.createSession(session))
      ),
    initialize: Ref.get(input.adapter).pipe(
      Effect.flatMap((current) => current.initialize)
    ),
    loadSession: (sessionId) =>
      Ref.get(input.adapter).pipe(
        Effect.flatMap((current) => current.loadSession(sessionId))
      ),
    resumeSession: (sessionId) => reattachSession(input.adapter, sessionId),
    prompt: retryPrompt,
    respondInteraction: (interaction) =>
      Ref.get(input.adapter).pipe(
        Effect.flatMap((current) =>
          current.respondInteraction === undefined
            ? new SelectedAdapterError({
                detail:
                  "The active Pi ACP adapter cannot accept interaction responses",
                reason: "invalid-state",
              })
            : current.respondInteraction(interaction)
        )
      ),
  });
};

const makePiRetryingSelectedAdapterContribution = (
  base: SelectedAdapterContribution,
  support: PiRetrySupport
): SelectedAdapterContribution => ({
  layer: (
    options: SelectedAdapterOptions
  ): Layer.Layer<SelectedAdapter, SelectedAdapterError> =>
    Layer.effect(
      SelectedAdapter,
      Effect.gen(function* () {
        const resources = yield* LayerMap.make(
          (_generation: number) => base.layer(options),
          { idleTimeToLive: RETIRED_PEER_TTL }
        );
        const generation = yield* Ref.make(0);
        const scope = yield* Scope.Scope;
        const initialAdapter = yield* currentAdapter(
          generation,
          resources,
          scope
        );
        const adapter = yield* Ref.make(initialAdapter);
        const env = environmentFor(options);
        return makeRetryingSelectedAdapterService({
          adapter,
          env,
          generation,
          modelId: support.resolveModelId(options.model, env),
          resources,
          scope,
          support,
        });
      })
    ),
  name: base.name,
});

export { makePiRetryingSelectedAdapterContribution };
export type { PiRetrySupport };
