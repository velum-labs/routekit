/**
 * The uniform approval model, regardless of transport: a CLI's approval
 * mechanism (blocked JSON-RPC request, SDK callback, SSE permission event)
 * becomes a canonical pending request holding a deferred; the answer resolves
 * the deferred, which unblocks the original protocol response. Teardown paths
 * settle every pending deferred so nothing can hang forever.
 */
import { randomUUID } from "node:crypto";

import type {
  HarnessApprovalDecision,
  HarnessRequestType as RouteHarnessRequestType
} from "@velum-labs/routekit-contracts";
import { Data, Effect, Deferred as EffectDeferred } from "effect";

export type ApprovalDecision = HarnessApprovalDecision;
export type HarnessRequestType = RouteHarnessRequestType;

/**
 * What the session auto-approves without surfacing a request. `all` is the
 * headless automation default (the historical `--force --trust` /
 * `bypassPermissions` behavior, now an explicit policy instead of a baked-in
 * flag); `edits` approves workspace writes but surfaces command execution;
 * `none` surfaces everything.
 */
export type ApprovalPolicy = { autoApprove: "all" | "edits" | "none" };

export const DEFAULT_AUTOMATION_APPROVAL_POLICY: ApprovalPolicy = { autoApprove: "all" };

/** The policy's verdict for a request type, or undefined to surface it. */
export function decideApproval(
  policy: ApprovalPolicy,
  requestType: HarnessRequestType
): ApprovalDecision | undefined {
  switch (policy.autoApprove) {
    case "all":
      return requestType === "tool_user_input" ? undefined : "accept";
    case "edits":
      return requestType === "file_change_approval" || requestType === "file_read_approval"
        ? "accept"
        : undefined;
    case "none":
      return undefined;
    default: {
      const exhausted: never = policy.autoApprove;
      throw new Error(`unsupported approval policy: ${String(exhausted)}`);
    }
  }
}

export class DeferredRejectedError extends Data.TaggedError("DeferredRejectedError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class ApprovalRequestRejectedError extends Data.TaggedError("ApprovalRequestRejectedError")<{
  readonly requestId: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export class ApprovalRequestNotFoundError extends Data.TaggedError("ApprovalRequestNotFoundError")<{
  readonly requestId: string;
  readonly message: string;
}> {}

export type Deferred<T> = {
  /** Effect-native wait path. Interrupting one waiter leaves the shared cell open. */
  effect: Effect.Effect<T, DeferredRejectedError>;
  /** Compatibility adapter for existing Promise-based tool callbacks. */
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  const deferred = EffectDeferred.makeUnsafe<T, DeferredRejectedError>();
  const effect = EffectDeferred.await(deferred);
  const compatibility = createPromiseAdapter<T>();
  return {
    effect,
    promise: compatibility.promise,
    resolve: (value) => {
      if (EffectDeferred.doneUnsafe(deferred, Effect.succeed(value))) {
        compatibility.resolve(value);
      }
    },
    reject: (cause) => {
      const error = new DeferredRejectedError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
      if (EffectDeferred.doneUnsafe(deferred, Effect.fail(error))) {
        compatibility.reject(error);
      }
    }
  };
}

export type PendingRequest = {
  requestId: string;
  requestType: HarnessRequestType;
  detail?: string;
  /** Effect-native approval wait. Multiple fibers safely share this result. */
  decisionEffect: Effect.Effect<ApprovalDecision, ApprovalRequestRejectedError>;
  /** Compatibility adapter for existing Promise-based tool drivers. */
  decision: Promise<ApprovalDecision>;
};

type PendingApproval = {
  deferred: EffectDeferred.Deferred<ApprovalDecision, ApprovalRequestRejectedError>;
  compatibility: PromiseAdapter<ApprovalDecision>;
};

/**
 * Per-session pending approval map. Requests are keyed by a server-generated
 * UUID (never the provider's own id — drivers keep their own correlation map
 * when the provider re-references requests by its ids).
 */
export class PendingRequests {
  readonly #pending = new Map<string, PendingApproval>();

  open(input: { requestType: HarnessRequestType; detail?: string }): PendingRequest {
    const requestId = randomUUID();
    const deferred = EffectDeferred.makeUnsafe<ApprovalDecision, ApprovalRequestRejectedError>();
    const decisionEffect = EffectDeferred.await(deferred);
    const compatibility = createPromiseAdapter<ApprovalDecision>();
    const request: PendingRequest = {
      requestId,
      requestType: input.requestType,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      decisionEffect,
      decision: compatibility.promise
    };
    this.#pending.set(requestId, { deferred, compatibility });
    return request;
  }

  /** Resolve one pending request. Returns false when the id is unknown/settled. */
  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) return false;
    this.#pending.delete(requestId);
    const completed = EffectDeferred.doneUnsafe(entry.deferred, Effect.succeed(decision));
    if (completed) entry.compatibility.resolve(decision);
    return completed;
  }

  resolveEffect(requestId: string, decision: ApprovalDecision): Effect.Effect<boolean> {
    return Effect.sync(() => this.resolve(requestId, decision));
  }

  /** Reject one pending request with a granular typed failure. */
  reject(requestId: string, cause: unknown): boolean {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) return false;
    this.#pending.delete(requestId);
    const error = new ApprovalRequestRejectedError({
      requestId,
      message: cause instanceof Error ? cause.message : String(cause),
      cause
    });
    const completed = EffectDeferred.doneUnsafe(entry.deferred, Effect.fail(error));
    if (completed) entry.compatibility.reject(error);
    return completed;
  }

  rejectEffect(requestId: string, cause: unknown): Effect.Effect<boolean> {
    return Effect.sync(() => this.reject(requestId, cause));
  }

  /** Look up and await a request when only its public id is available. */
  wait(
    requestId: string
  ): Effect.Effect<ApprovalDecision, ApprovalRequestNotFoundError | ApprovalRequestRejectedError> {
    return Effect.suspend<
      ApprovalDecision,
      ApprovalRequestNotFoundError | ApprovalRequestRejectedError,
      never
    >(() => {
      const entry = this.#pending.get(requestId);
      return entry === undefined
        ? Effect.fail(
            new ApprovalRequestNotFoundError({
              requestId,
              message: `unknown pending request ${requestId}`
            })
          )
        : EffectDeferred.await(entry.deferred);
    });
  }

  /** Settle every pending request (teardown paths call this with "cancel"). */
  settleAll(decision: ApprovalDecision): number {
    let settled = 0;
    for (const [requestId, entry] of this.#pending) {
      this.#pending.delete(requestId);
      if (EffectDeferred.doneUnsafe(entry.deferred, Effect.succeed(decision))) {
        entry.compatibility.resolve(decision);
        settled += 1;
      }
    }
    return settled;
  }

  settleAllEffect(decision: ApprovalDecision): Effect.Effect<number> {
    return Effect.sync(() => this.settleAll(decision));
  }

  get size(): number {
    return this.#pending.size;
  }
}

type PromiseAdapter<A> = {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (cause: unknown) => void;
};

/**
 * Thin callback compatibility for existing tool drivers. It mirrors completion
 * without running the Effect program in a second runtime.
 */
function createPromiseAdapter<A>(): PromiseAdapter<A> {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((onSuccess, onFailure) => {
    resolve = onSuccess;
    reject = onFailure;
  });
  return {
    promise,
    resolve,
    reject
  };
}
