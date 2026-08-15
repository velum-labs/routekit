import { Data, Effect, Fiber, Scope } from "effect";
import type { ApprovalDecision } from "./approvals.js";
import type { ResumeCursor, SessionHandle, SessionTurnInput } from "./contract.js";
import { HarnessError } from "./errors.js";
import type { HarnessEvent } from "./events.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export type TurnLease = {
  readonly signal: AbortSignal;
  complete(): void;
  dispose(): void;
};

export class TurnAlreadyActiveError extends Data.TaggedError("TurnAlreadyActiveError")<{
  readonly message: string;
}> {}

/**
 * Enforces the session contract's one-live-turn rule and gives every driver
 * an internal abort signal. Disposing an incomplete lease aborts the native
 * operation, which makes an async iterator's `return()` a real cancellation.
 */
export class SingleFlightTurnController {
  #active: { controller: AbortController; detachExternal: () => void } | undefined;

  #claim(external?: AbortSignal): TurnLease | TurnAlreadyActiveError {
    if (this.#active !== undefined) {
      return new TurnAlreadyActiveError({
        message: "a turn is already active for this session"
      });
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(external?.reason);
    external?.addEventListener("abort", onAbort, { once: true });
    if (external?.aborted === true) onAbort();
    const active = {
      controller,
      detachExternal: () => external?.removeEventListener("abort", onAbort)
    };
    this.#active = active;
    let completed = false;
    let disposed = false;
    return {
      signal: controller.signal,
      complete: () => {
        completed = true;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (!completed) controller.abort(new Error("turn iterator closed"));
        active.detachExternal();
        if (this.#active === active) this.#active = undefined;
      }
    };
  }

  /**
   * Effect-native scoped lease. Acquisition and finalization are
   * interruption-safe, and an incomplete lease aborts its native operation.
   */
  lease(external?: AbortSignal): Effect.Effect<TurnLease, TurnAlreadyActiveError, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.suspend(() => {
        const claimed = this.#claim(external);
        return claimed instanceof TurnAlreadyActiveError
          ? Effect.fail(claimed)
          : Effect.succeed(claimed);
      }),
      (lease) => Effect.sync(() => lease.dispose())
    );
  }

  /**
   * Run one turn on an owned child fiber. Caller interruption interrupts the
   * child, closes its scope, aborts the native signal, and releases the slot.
   */
  run<A, E, R>(
    work: (signal: AbortSignal) => Effect.Effect<A, E, R>,
    external?: AbortSignal
  ): Effect.Effect<A, E | TurnAlreadyActiveError, Exclude<R, Scope.Scope>> {
    const self = this;
    return Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* self.lease(external);
        const worker = yield* Effect.forkScoped(work(lease.signal), {
          startImmediately: true
        });
        const value = yield* Fiber.join(worker);
        yield* Effect.sync(() => lease.complete());
        return value;
      })
    );
  }

  /** Compatibility adapter for existing synchronous tool-driver setup. */
  start(external?: AbortSignal): TurnLease {
    const claimed = this.#claim(external);
    if (claimed instanceof TurnAlreadyActiveError) {
      throw new HarnessError("session_busy", claimed.message, { cause: claimed });
    }
    return claimed;
  }

  interrupt(reason: unknown = new Error("turn interrupted")): void {
    this.#active?.controller.abort(reason);
  }

  get active(): boolean {
    return this.#active !== undefined;
  }
}

/**
 * A session wrapper that owns unregistering itself from its instance. `stop`
 * is idempotent even when the underlying driver's stop operation rejects.
 */
export class ManagedSession implements SessionHandle {
  readonly #session: SessionHandle;
  readonly #release: () => void;
  #stopPromise: Promise<void> | undefined;

  constructor(session: SessionHandle, release: () => void) {
    this.#session = session;
    this.#release = release;
  }

  get sessionId(): string {
    return this.#session.sessionId;
  }

  sendTurn(input: SessionTurnInput): AsyncIterable<HarnessEvent> {
    return this.#session.sendTurn(input);
  }

  respondToRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.#session.respondToRequest(requestId, decision);
  }

  interrupt(): Promise<void> {
    return this.#session.interrupt();
  }

  resumeCursor(): ResumeCursor | undefined {
    return this.#session.resumeCursor();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= (async () => {
      try {
        await this.#session.stop();
      } finally {
        this.#release();
      }
    })();
    return this.#stopPromise;
  }
}

/**
 * Owns the live sessions created by one harness instance. Stopped sessions
 * unregister immediately, while instance disposal settles every still-live
 * session and aggregates failures only after all stop operations were tried.
 */
export class SessionResourceRegistry {
  readonly #sessions = new Set<ManagedSession>();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  manage(session: SessionHandle): ManagedSession {
    if (this.#disposed) {
      throw new HarnessError("session_closed", "harness instance is disposed");
    }
    let managed: ManagedSession;
    managed = new ManagedSession(session, () => this.#sessions.delete(managed));
    this.#sessions.add(managed);
    return managed;
  }

  get size(): number {
    return this.#sessions.size;
  }

  assertOpen(): void {
    if (this.#disposed) {
      throw new HarnessError("session_closed", "harness instance is disposed");
    }
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    this.#disposePromise ??= (async () => {
      const sessions = [...this.#sessions];
      const results = await Promise.allSettled(sessions.map((session) => session.stop()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "one or more harness sessions failed to stop");
      }
    })();
    return this.#disposePromise;
  }
}

export function resumeStringField(
  resume: ResumeCursor | undefined,
  kind: ResumeCursor["kind"],
  field: string
): string | undefined {
  if (resume === undefined || resume.kind !== kind || resume.data === null) return undefined;
  if (typeof resume.data !== "object" || Array.isArray(resume.data)) return undefined;
  const value = (resume.data as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
