import type { RouteKitControlMethod } from "@velum-labs/routekit-control";
import { IdempotencyStore } from "@velum-labs/routekit-control";
import { ControlError } from "@velum-labs/routekit-runtime";

export type HostIdempotencyBegin =
  | { state: "started"; operationId: string }
  | { state: "completed"; result: unknown };

/**
 * Host-owned idempotency retention survives disposable daemon worker rolls.
 * The shared control store owns expiry and capacity; this port only maps IPC
 * operation ids to the store entries completed by workers.
 */
export class HostIdempotencyCoordinator {
  readonly #store: IdempotencyStore;
  readonly #operations = new Map<
    string,
    {
      key: string;
      ownerId: number;
      entry: { fingerprint: string; promise: Promise<unknown> };
    }
  >();
  #sequence = 0;

  constructor(store = new IdempotencyStore()) {
    this.#store = store;
  }

  async begin(
    method: RouteKitControlMethod,
    key: string,
    fingerprint: string,
    ownerId = 0
  ): Promise<HostIdempotencyBegin> {
    const storageKey = `${method}:${key}`;
    const existing = this.#store.get(storageKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new ControlError({
          code: "conflict",
          message: "idempotency key was reused with different parameters"
        });
      }
      return { state: "completed", result: await existing.promise };
    }

    const operationId = `host-${++this.#sequence}`;
    let resolve!: (result: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    void promise.catch(() => undefined);
    const entry = { fingerprint, promise };
    this.#store.set(storageKey, entry);
    this.#operations.set(operationId, { key: storageKey, ownerId, entry });
    Object.assign(entry, { resolve, reject });
    return { state: "started", operationId };
  }

  complete(operationId: string, result: unknown): void {
    const operation = this.#operation(operationId);
    (
      operation.entry as typeof operation.entry & {
        resolve(result: unknown): void;
      }
    ).resolve(result);
    this.#store.complete(operation.key, operation.entry);
    this.#operations.delete(operationId);
  }

  fail(operationId: string): void {
    const operation = this.#operation(operationId);
    (
      operation.entry as typeof operation.entry & {
        reject(error: Error): void;
      }
    ).reject(new Error("daemon worker operation failed"));
    this.#store.delete(operation.key, operation.entry);
    this.#operations.delete(operationId);
  }

  failOwner(ownerId: number): void {
    for (const [operationId, operation] of this.#operations) {
      if (operation.ownerId === ownerId) this.fail(operationId);
    }
  }

  #operation(operationId: string): {
    key: string;
    ownerId: number;
    entry: { fingerprint: string; promise: Promise<unknown> };
  } {
    const operation = this.#operations.get(operationId);
    if (operation === undefined) {
      throw new Error(`unknown host idempotency operation: ${operationId}`);
    }
    return operation;
  }
}
