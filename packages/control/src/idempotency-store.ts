export type IdempotencyEntry = {
  fingerprint: string;
  promise: Promise<unknown>;
  completedAt?: number;
};

export type IdempotencyStoreOptions = {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
};

/**
 * Process-owned idempotency state. Hosts can retain one store while replacing
 * disposable control handlers or daemon workers.
 */
export class IdempotencyStore {
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #operations = new Map<string, IdempotencyEntry>();

  constructor(options: IdempotencyStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): IdempotencyEntry | undefined {
    const existing = this.#operations.get(key);
    if (existing === undefined) return undefined;
    if (
      existing.completedAt !== undefined &&
      this.#now() - existing.completedAt > this.#ttlMs
    ) {
      this.#operations.delete(key);
      return undefined;
    }
    return existing;
  }

  set(key: string, entry: IdempotencyEntry): void {
    this.#operations.set(key, entry);
  }

  complete(key: string, entry: IdempotencyEntry): void {
    if (this.#operations.get(key) !== entry) return;
    entry.completedAt = this.#now();
    while (this.#operations.size > this.#maxEntries) {
      const oldest = this.#operations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#operations.delete(oldest);
    }
  }

  delete(key: string, entry?: IdempotencyEntry): void {
    if (entry !== undefined && this.#operations.get(key) !== entry) return;
    this.#operations.delete(key);
  }

  get size(): number {
    return this.#operations.size;
  }
}
