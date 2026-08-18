export interface StateStore {
  /**
   * Release any resources the store holds (open database handles, file
   * descriptors, pooled connections). Optional: a store backed by nothing that
   * needs closing (an in-memory map, a no-op stub) omits it. Implementations
   * MUST be idempotent — calling `close` more than once is safe and a no-op
   * after the first call. Resource-backed stores (e.g. the sqlite builtin)
   * implement this and wire it to the runtime's deterministic teardown so
   * on-disk artifacts like SQLite's WAL/SHM sidecars are flushed and removed
   * rather than left dangling.
   */
  readonly close?: (() => Promise<void>) | undefined;
  readonly exec: (sql: string, params?: readonly unknown[]) => Promise<void>;
  readonly get: (key: string) => Promise<string | undefined>;
  readonly name: string;
  readonly query: <Row = unknown>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<readonly Row[]>;
  readonly set: (key: string, value: string) => Promise<void>;
}
export type StateStoreExport = StateStore | readonly StateStore[];

export interface StoreResolver {
  readonly db: (name: string) => Promise<StateStore>;
  readonly state: StateStore;
}
