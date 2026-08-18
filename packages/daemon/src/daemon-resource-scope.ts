import { ResourceScope } from "@velum-labs/routekit-runtime/lifecycle";

/**
 * Daemon-owned resource scope. Borrowed host resources are deliberately not
 * finalized by a disposable worker.
 */
export class DaemonResourceScope {
  readonly #scope: ResourceScope;

  constructor(shutdownBudgetMs?: number) {
    this.#scope = new ResourceScope(shutdownBudgetMs === undefined ? {} : { shutdownBudgetMs });
  }

  own<T>(resource: T, finalize?: (resource: T) => void | Promise<void>): T {
    return this.#scope.own(resource, finalize === undefined ? {} : { finalize });
  }

  borrow<T>(resource: T): T {
    return this.#scope.borrow(resource);
  }

  defer(finalizer: () => void | Promise<void>): void {
    this.#scope.defer(finalizer);
  }

  transferTo(target: DaemonResourceScope): void {
    this.#scope.transferTo(target.#scope);
  }

  releaseAll(): void {
    this.#scope.releaseAll();
  }

  async dispose(): Promise<void> {
    await this.#scope.dispose();
  }
}
