import {
  Context,
  Duration,
  Effect,
  Layer,
  LayerMap,
  Ref,
  Stream,
} from "effect";

import type { AgentRuntimeEvent } from "../../../contracts/author/src/agent-event.ts";
import type { HarnessName } from "../../../contracts/internal/src/ids.ts";
import type { AgentAdapterEvent } from "../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { log } from "../../../contracts/author/src/logger.ts";

import type {
  MissingSelectedAdapterError,
  SelectedAdapterInteractionResponse,
  SelectedAdapterOptions,
  SelectedAdapterPrepare,
  SessionOwnershipMismatchError,
} from "./inventory.ts";
import type {
  SessionOwnershipPersistenceError,
  SessionOwnershipStoreShape,
} from "./ownership-store.ts";
import type {
  AdapterResourceKey,
  AdapterResources,
  SessionCache,
} from "./session-resolution.ts";

import {
  interruptOnCancel,
  isRuntimeEvent,
  toSessionUpdate,
} from "./cancellation.ts";
import { invalidateOnPeerExit } from "./coordinator-peer-exit.ts";
import {
  AdapterInventory,
  MissingSessionOwnershipError,
  SelectedAdapter,
  SelectedAdapterError,
} from "./inventory.ts";
import { SessionOwnershipStore } from "./ownership-store.ts";
import {
  makeFreshResourceKey,
  ownershipRecordFor,
  rememberSession,
  resolveOwnedResource,
} from "./session-resolution.ts";

type SelectedAdapterOutput =
  | { readonly sessionId: string; readonly type: "session-started" }
  | { readonly type: "session-update"; readonly update: AgentAdapterEvent }
  | { readonly event: AgentRuntimeEvent; readonly type: "runtime-event" };

const SESSION_IDLE_TTL_MINUTES = 10;
const SESSION_IDLE_TTL = Duration.minutes(SESSION_IDLE_TTL_MINUTES);

interface SelectedAdapterInvocation {
  readonly cancelState?: Ref.Ref<boolean> | undefined;
  readonly cancelSignal?: Effect.Effect<unknown> | undefined;
  readonly contextWindow?: number | undefined;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly extraSkillDirs?: readonly string[] | undefined;
  readonly harness: HarnessName;
  readonly interactionSurface?: boolean | undefined;
  readonly model?: string | null | undefined;
  readonly parameters?: SelectedAdapterOptions["parameters"];
  readonly prepare?: SelectedAdapterPrepare | undefined;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
  readonly systemPrompt?: string | undefined;
}

type SelectedAdapterResponseInput = SelectedAdapterInteractionResponse & {
  readonly sessionId: string;
};

type CoordinatorInvokeError =
  | MissingSelectedAdapterError
  | MissingSessionOwnershipError
  | SelectedAdapterError
  | SessionOwnershipMismatchError
  | SessionOwnershipPersistenceError;

interface SelectedAdapterCoordinatorShape {
  readonly invoke: (
    input: SelectedAdapterInvocation
  ) => Stream.Stream<SelectedAdapterOutput, CoordinatorInvokeError>;
  readonly respondInteraction: (
    input: SelectedAdapterResponseInput
  ) => Effect.Effect<void, MissingSessionOwnershipError | SelectedAdapterError>;
}

class SelectedAdapterCoordinator extends Context.Service<
  SelectedAdapterCoordinator,
  SelectedAdapterCoordinatorShape
>()("ori/selected-adapter/SelectedAdapterCoordinator") {}

/**
 * Compensation for a creation whose mapping did not land: the resource is
 * released and the turn fails before any session ID reaches the caller, so a
 * session can never look resumable while having no durable record behind it.
 */
const persistNewOwnership = Effect.fn(
  "SelectedAdapterCoordinator.persistNewOwnership"
)(function* (input: {
  readonly adapter: SelectedAdapter["Service"];
  readonly key: AdapterResourceKey;
  readonly resources: AdapterResources;
  readonly sessionId: string;
  readonly store: SessionOwnershipStoreShape;
}) {
  const adapterState =
    input.adapter.captureState === undefined
      ? undefined
      : yield* input.adapter.captureState(input.sessionId);
  const record = yield* ownershipRecordFor({
    adapterState,
    key: input.key,
    sessionId: input.sessionId,
  });
  yield* input.store
    .write(record)
    .pipe(
      Effect.catch((error) =>
        input.resources
          .invalidate(input.key)
          .pipe(Effect.andThen(Effect.fail(error)))
      )
    );
});

const restoreAdapterState = (input: {
  readonly adapter: SelectedAdapter["Service"];
  readonly sessionId: string;
  readonly state: string | undefined;
}): Effect.Effect<void, SelectedAdapterError> =>
  input.state === undefined || input.adapter.restoreState === undefined
    ? Effect.void
    : input.adapter.restoreState({
        sessionId: input.sessionId,
        state: input.state,
      });

interface InvokeAdapterInput {
  readonly adapter: SelectedAdapter["Service"];
  readonly adapterState: string | undefined;
  readonly cache: SessionCache;
  readonly input: SelectedAdapterInvocation;
  readonly key: AdapterResourceKey;
  readonly resources: AdapterResources;
  readonly resume: boolean;
  readonly store: SessionOwnershipStoreShape;
}

const openAdapterSession = Effect.fn(
  "SelectedAdapterCoordinator.openAdapterSession"
)(function* (params: InvokeAdapterInput) {
  const { adapter, input, key, resources, resume, store } = params;
  yield* adapter.initialize;
  if (resume && input.sessionId !== undefined) {
    // A rebuilt resource reaches the session cache only once its session is
    // open, so nothing there bounds it yet. Releasing it on the way out is what
    // stops a retried unresumable session from stacking up idle agents.
    const { sessionId } = input;
    yield* Effect.gen(function* () {
      yield* restoreAdapterState({
        adapter,
        sessionId,
        state: params.adapterState,
      });
      yield* adapter.resumeSession(sessionId);
    }).pipe(
      Effect.catch((error) =>
        resources.invalidate(key).pipe(Effect.andThen(Effect.fail(error)))
      )
    );
    return sessionId;
  }
  const sessionId = yield* adapter.createSession({ cwd: input.cwd });
  yield* persistNewOwnership({
    adapter,
    key,
    resources,
    sessionId,
    store,
  });
  const launchId = key.options.env?.ORI_OPENROUTER_SESSION_ID;
  if (launchId !== undefined) {
    log.info("OpenRouter launch mapped to session", {
      launchId,
      sessionId,
    });
  }
  return sessionId;
});

const invokeAdapter = (
  params: InvokeAdapterInput
): Stream.Stream<
  SelectedAdapterOutput,
  SelectedAdapterError | SessionOwnershipPersistenceError
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { adapter, cache, input, key, resources } = params;
      const sessionId = yield* openAdapterSession(params);
      yield* rememberSession({
        cache,
        key,
        resources,
        sessionId,
      });
      const mappedUpdates = interruptOnCancel(
        adapter.prompt({
          interactionSurface: input.interactionSurface,
          prompt: input.prompt,
          sessionId,
        }),
        {
          signal: input.cancelSignal,
          state: input.cancelState,
        },
        adapter.cancel.pipe(Effect.ignore)
      ).pipe(
        Stream.map((event) =>
          isRuntimeEvent(event) ? event : toSessionUpdate(event)
        )
      );
      const started: SelectedAdapterOutput = {
        sessionId,
        type: "session-started",
      };
      return Stream.make(started).pipe(Stream.concat(mappedUpdates));
    })
  ).pipe(invalidateOnPeerExit(params));

const makeInvoke =
  (input: {
    readonly cache: SessionCache;
    readonly inventory: AdapterInventory["Service"];
    readonly resourceSequence: Ref.Ref<number>;
    readonly resources: AdapterResources;
    readonly store: SessionOwnershipStoreShape;
  }): SelectedAdapterCoordinatorShape["invoke"] =>
  (invocation) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const contribution = yield* input.inventory.select(invocation.harness);
        const { sessionId } = invocation;
        const resolved =
          sessionId === undefined
            ? {
                adapterState: undefined,
                ...(yield* makeFreshResourceKey({
                  contribution,
                  request: invocation,
                  resources: input.resources,
                  resourceSequence: input.resourceSequence,
                })),
              }
            : yield* resolveOwnedResource({
                cache: input.cache,
                contribution,
                request: invocation,
                resources: input.resources,
                resourceSequence: input.resourceSequence,
                sessionId,
                store: input.store,
              });
        return invokeAdapter({
          adapter: Context.get(resolved.context, SelectedAdapter),
          adapterState: resolved.adapterState,
          cache: input.cache,
          input: invocation,
          key: resolved.key,
          resources: input.resources,
          resume: sessionId !== undefined,
          store: input.store,
        });
      })
    );

const withoutSessionId = (
  input: SelectedAdapterResponseInput
): SelectedAdapterInteractionResponse =>
  input.kind === "permission"
    ? {
        correlationId: input.correlationId,
        kind: "permission",
        response: input.response,
      }
    : {
        correlationId: input.correlationId,
        kind: "elicitation",
        response: input.response,
      };

/**
 * Answers only against live resources. A pending interaction cannot outlive the
 * resource that raised it, so rebuilding a session from its record here would
 * resolve a request no peer is still waiting on.
 */
const makeRespondInteraction =
  (
    resources: AdapterResources,
    cache: SessionCache
  ): SelectedAdapterCoordinatorShape["respondInteraction"] =>
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const key = (yield* Ref.get(cache)).get(input.sessionId);
        if (key === undefined) {
          return yield* new MissingSessionOwnershipError({
            sessionId: input.sessionId,
          });
        }
        const context = yield* resources.contextEffect(key);
        const adapter = Context.get(context, SelectedAdapter);
        if (adapter.respondInteraction === undefined) {
          return yield* new SelectedAdapterError({
            detail: `Selected adapter ${key.contribution.name} does not accept interaction responses`,
            reason: "invalid-state",
          });
        }
        yield* adapter.respondInteraction(withoutSessionId(input));
      })
    );

const layerSelectedAdapterCoordinator: Layer.Layer<
  SelectedAdapterCoordinator,
  never,
  AdapterInventory | SessionOwnershipStore
> = Layer.effect(
  SelectedAdapterCoordinator,
  Effect.gen(function* () {
    const inventory = yield* AdapterInventory;
    const store = yield* SessionOwnershipStore;
    const cache = yield* Ref.make<ReadonlyMap<string, AdapterResourceKey>>(
      new Map()
    );
    const resourceSequence = yield* Ref.make(0);
    const resources = yield* LayerMap.make(
      (key: AdapterResourceKey) => key.contribution.layer(key.options),
      { idleTimeToLive: SESSION_IDLE_TTL }
    );
    return SelectedAdapterCoordinator.of({
      invoke: makeInvoke({
        cache,
        inventory,
        resources,
        resourceSequence,
        store,
      }),
      respondInteraction: makeRespondInteraction(resources, cache),
    });
  })
);

export { layerSelectedAdapterCoordinator, SelectedAdapterCoordinator };
export type {
  CoordinatorInvokeError,
  SelectedAdapterCoordinatorShape,
  SelectedAdapterInvocation,
  SelectedAdapterOutput as SelectedAdapterOutputType,
  SelectedAdapterResponseInput,
};
