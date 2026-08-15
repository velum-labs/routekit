import type { Scope } from "effect";

import { Context, Deferred, Effect, Layer, Option, Ref } from "effect";

import { RuntimeReloadInterruptedError } from "../../../../contracts/internal/src/errors.ts";

const DEFAULT_DRAIN_TIMEOUT_MS = 2000;
const EMPTY_COUNT = 0;
const FIRST_INVOCATION_ID = 1;

interface ReloadCoordinatorState {
  readonly active: ReadonlyMap<number, InvocationInterrupt>;
  readonly emptySignal: EmptySignal;
  readonly nextInvocationId: number;
  readonly resumeSignal: ResumeSignal | null;
}

type InvocationInterrupt = Deferred.Deferred<
  never,
  RuntimeReloadInterruptedError
>;
type EmptySignal = Deferred.Deferred<true>;
type ResumeSignal = Deferred.Deferred<true>;

type InvocationReservation =
  | {
      readonly kind: "accepted";
      readonly lease: ReloadInvocationLease;
    }
  | {
      readonly kind: "paused";
      readonly resumeSignal: ResumeSignal;
    };

interface ReloadInvocationLease {
  readonly end: Effect.Effect<void>;
  readonly interrupt: Effect.Effect<never, RuntimeReloadInterruptedError>;
}

interface ReloadDrainResult {
  readonly activeCount: number;
  readonly drained: boolean;
}

interface ReloadCoordinatorShape {
  readonly activeCount: Effect.Effect<number>;
  readonly beginInvocation: Effect.Effect<ReloadInvocationLease>;
  readonly drain: (options?: {
    readonly timeoutMs?: number;
  }) => Effect.Effect<ReloadDrainResult>;
  readonly drainScope: (options?: {
    readonly timeoutMs?: number;
  }) => Effect.Effect<ReloadDrainResult, never, Scope.Scope>;
  readonly resumeInvocations: Effect.Effect<void>;
}

const pauseInvocations = Effect.fn("ReloadCoordinator.pauseInvocations")(
  function* (state: Ref.Ref<ReloadCoordinatorState>) {
    const resumeSignal = yield* Deferred.make<true>();
    yield* Ref.update(state, (current) =>
      current.resumeSignal === null
        ? {
            ...current,
            resumeSignal,
          }
        : current
    );
  }
);

const resumePausedInvocations = Effect.fn(
  "ReloadCoordinator.resumePausedInvocations"
)(function* (state: Ref.Ref<ReloadCoordinatorState>) {
  const resumeSignal = yield* Ref.modify(state, (current) => [
    current.resumeSignal,
    {
      ...current,
      resumeSignal: null,
    },
  ]);
  if (resumeSignal !== null) {
    yield* Deferred.succeed(resumeSignal, true).pipe(Effect.asVoid);
  }
});

const releaseInvocationLease = Effect.fn(
  "ReloadCoordinator.releaseInvocationLease"
)(function* (state: Ref.Ref<ReloadCoordinatorState>, invocationId: number) {
  const emptySignal = yield* Ref.modify(state, (current) => {
    const active = new Map(current.active);
    active.delete(invocationId);
    return [
      active.size === EMPTY_COUNT ? current.emptySignal : null,
      {
        ...current,
        active,
      },
    ];
  });

  if (emptySignal !== null) {
    yield* Deferred.succeed(emptySignal, true).pipe(Effect.asVoid);
  }
});

const acceptInvocationLease = (input: {
  readonly current: ReloadCoordinatorState;
  readonly emptySignal: EmptySignal;
  readonly interrupt: InvocationInterrupt;
  readonly state: Ref.Ref<ReloadCoordinatorState>;
}): readonly [InvocationReservation, ReloadCoordinatorState] => {
  const { current } = input;
  if (current.resumeSignal !== null) {
    return [
      {
        kind: "paused",
        resumeSignal: current.resumeSignal,
      },
      current,
    ];
  }

  return [
    {
      kind: "accepted",
      lease: {
        end: releaseInvocationLease(input.state, current.nextInvocationId),
        interrupt: Deferred.await(input.interrupt),
      },
    },
    {
      ...current,
      active: new Map([
        ...current.active,
        [current.nextInvocationId, input.interrupt],
      ]),
      emptySignal:
        current.active.size === EMPTY_COUNT
          ? input.emptySignal
          : current.emptySignal,
      nextInvocationId: current.nextInvocationId + 1,
    },
  ];
};

// The explicit call-signature annotation (rather than letting `Effect.fn`
// infer it) keeps the self-call below well-typed: an uninferred recursive
// `Effect.fn` reference otherwise degrades to `any`.
const acquireInvocationLease: (
  state: Ref.Ref<ReloadCoordinatorState>
) => Effect.Effect<ReloadInvocationLease> = Effect.fn("acquireInvocationLease")(
  function* (state) {
    const interrupt = yield* Deferred.make<
      never,
      RuntimeReloadInterruptedError
    >();
    const emptySignal = yield* Deferred.make<true>();
    const reservation = yield* Ref.modify(state, (current) =>
      acceptInvocationLease({
        current,
        emptySignal,
        interrupt,
        state,
      })
    );
    if (reservation.kind === "accepted") {
      return reservation.lease;
    }

    yield* Deferred.await(reservation.resumeSignal);
    return yield* acquireInvocationLease(state);
  }
);

const waitForDrain = Effect.fn("ReloadCoordinator.waitForDrain")(function* (
  state: Ref.Ref<ReloadCoordinatorState>,
  timeoutMs: number
) {
  const snapshot = yield* Ref.get(state);
  if (snapshot.active.size === EMPTY_COUNT) {
    return {
      activeCount: EMPTY_COUNT,
      drained: true,
    };
  }

  const completed = yield* Deferred.await(snapshot.emptySignal).pipe(
    Effect.timeoutOption(`${timeoutMs} millis`)
  );
  if (Option.isSome(completed)) {
    return {
      activeCount: EMPTY_COUNT,
      drained: true,
    };
  }

  const activeCount = (yield* Ref.get(state)).active.size;
  return {
    activeCount,
    drained: activeCount === EMPTY_COUNT,
  };
});

const interruptActiveInvocations = Effect.fn(
  "ReloadCoordinator.interruptActiveInvocations"
)(function* (state: Ref.Ref<ReloadCoordinatorState>) {
  const { active } = yield* Ref.get(state);
  yield* Effect.all(
    [...active.values()].map((interrupt) =>
      Deferred.fail(
        interrupt,
        new RuntimeReloadInterruptedError({
          detail: "in-flight run interrupted by edit-mode reload",
        })
      )
    ),
    { concurrency: "unbounded" }
  ).pipe(Effect.asVoid);
});

const drainInvocations = Effect.fn("ReloadCoordinator.drainInvocations")(
  function* (
    state: Ref.Ref<ReloadCoordinatorState>,
    options?: { readonly timeoutMs?: number }
  ) {
    yield* pauseInvocations(state);
    const result = yield* waitForDrain(
      state,
      options?.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
    );
    if (!result.drained) {
      yield* interruptActiveInvocations(state);
    }
    return result;
  }
);

export class ReloadCoordinator extends Context.Service<
  ReloadCoordinator,
  ReloadCoordinatorShape
>()("routekit-eval/runtime/ReloadCoordinator") {
  static readonly layer = Layer.effect(ReloadCoordinator)(
    Effect.gen(function* () {
      const emptySignal = yield* Deferred.make<true>();
      const state = yield* Ref.make<ReloadCoordinatorState>({
        active: new Map(),
        emptySignal,
        nextInvocationId: FIRST_INVOCATION_ID,
        resumeSignal: null,
      });

      const activeCount = Ref.get(state).pipe(
        Effect.map((current) => current.active.size)
      );
      const resumeInvocations = resumePausedInvocations(state);
      const drain = (options?: {
        readonly timeoutMs?: number;
      }): Effect.Effect<ReloadDrainResult> =>
        drainInvocations(state, options).pipe(
          Effect.onInterrupt(() => resumeInvocations)
        );

      return ReloadCoordinator.of({
        activeCount,
        beginInvocation: acquireInvocationLease(state),
        drain,
        drainScope: (options) =>
          Effect.acquireRelease(drain(options), () => resumeInvocations),
        resumeInvocations,
      });
    })
  );
}

export type {
  ReloadInvocationLease,
  ReloadDrainResult,
  ReloadCoordinatorShape,
};
