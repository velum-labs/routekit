export type ResourceFinalizer = () => void | Promise<void>;

export type ResourceOwnership = "owned" | "borrowed";

export type ResourceScopeOptions = {
  /** Maximum time spent awaiting finalizers. Unset means no shutdown deadline. */
  shutdownBudgetMs?: number;
};

export type OwnedResourceOptions<T> = {
  finalize?: (resource: T) => void | Promise<void>;
};

type ResourceEntry = {
  readonly finalize: ResourceFinalizer;
};

function defaultFinalizer<T>(resource: T): ResourceFinalizer {
  const candidate = resource as {
    close?: () => void | Promise<void>;
    dispose?: () => void | Promise<void>;
    [Symbol.asyncDispose]?: () => Promise<void>;
    [Symbol.dispose]?: () => void;
  };
  if (typeof candidate[Symbol.asyncDispose] === "function") {
    return async () => await candidate[Symbol.asyncDispose]!();
  }
  if (typeof candidate[Symbol.dispose] === "function") {
    return () => candidate[Symbol.dispose]!();
  }
  if (typeof candidate.close === "function") {
    return async () => await candidate.close!();
  }
  if (typeof candidate.dispose === "function") {
    return async () => await candidate.dispose!();
  }
  throw new TypeError("owned resource requires a finalizer, close(), or dispose()");
}

function validateBudget(budgetMs: number | undefined): void {
  if (budgetMs !== undefined && (!Number.isFinite(budgetMs) || budgetMs < 0)) {
    throw new RangeError("shutdown budget must be a non-negative finite number");
  }
}

export class ResourceDisposalTimeoutError extends Error {
  readonly budgetMs: number;

  constructor(budgetMs: number) {
    super(`resource disposal exceeded its ${budgetMs}ms shutdown budget`);
    this.name = "ResourceDisposalTimeoutError";
    this.budgetMs = budgetMs;
  }
}

/**
 * Owns a LIFO stack of resources during startup and shutdown.
 *
 * Borrowed resources are deliberately not registered for disposal. Successful
 * startup can transfer all owned resources into a longer-lived scope; failed
 * startup disposes this scope and attempts every finalizer.
 */
export class ResourceScope implements AsyncDisposable {
  readonly #shutdownBudgetMs: number | undefined;
  #entries: ResourceEntry[] = [];
  #disposePromise: Promise<void> | undefined;
  #sealed = false;

  constructor(options: ResourceScopeOptions = {}) {
    validateBudget(options.shutdownBudgetMs);
    this.#shutdownBudgetMs = options.shutdownBudgetMs;
  }

  own<T>(resource: T, options: OwnedResourceOptions<T> = {}): T {
    this.#assertOpen();
    const finalize =
      options.finalize === undefined
        ? defaultFinalizer(resource)
        : async () => await options.finalize!(resource);
    this.#entries.push({ finalize });
    return resource;
  }

  borrow<T>(resource: T): T {
    this.#assertOpen();
    return resource;
  }

  defer(finalizer: ResourceFinalizer): void {
    this.#assertOpen();
    this.#entries.push({ finalize: finalizer });
  }

  /**
   * Move ownership into another scope. The source becomes inert, so a later
   * rollback cannot dispose resources that have already been published.
   */
  transferTo(target: ResourceScope): void {
    this.#assertOpen();
    target.#accept(this.#entries);
    this.#entries = [];
    this.#sealed = true;
  }

  /**
   * Transfer ownership to the caller rather than another scope.
   * Intended for factory functions whose returned values are the owner.
   */
  releaseAll(): void {
    this.#assertOpen();
    this.#entries = [];
    this.#sealed = true;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#sealed = true;
    const entries = this.#entries.splice(0).reverse();
    this.#disposePromise = this.#disposeEntries(entries);
    return this.#disposePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  #accept(entries: readonly ResourceEntry[]): void {
    this.#assertOpen();
    this.#entries.push(...entries);
  }

  #assertOpen(): void {
    if (this.#sealed || this.#disposePromise !== undefined) {
      throw new Error("resource scope is no longer accepting resources");
    }
  }

  async #disposeEntries(entries: readonly ResourceEntry[]): Promise<void> {
    const errors: unknown[] = [];
    const deadline =
      this.#shutdownBudgetMs === undefined ? undefined : Date.now() + this.#shutdownBudgetMs;
    for (const entry of entries) {
      try {
        const result = Promise.resolve().then(entry.finalize);
        if (deadline === undefined) {
          await result;
          continue;
        }
        const remaining = Math.max(0, deadline - Date.now());
        await Promise.race([
          result,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new ResourceDisposalTimeoutError(this.#shutdownBudgetMs!)),
              remaining
            );
            void result.then(
              () => clearTimeout(timer),
              () => clearTimeout(timer)
            );
          })
        ]);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "one or more resource finalizers failed");
    }
  }
}
