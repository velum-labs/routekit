import { Effect } from "effect";

import {
  type DocumentReadResult,
  VersionedDocumentStore,
  type VersionedDocumentStoreOptions
} from "../versioned-document-store.js";

/**
 * Effect façade over RouteKit's validated, atomic document store.
 *
 * The existing persistence and wire format remain unchanged; this adapter
 * lets Effect-native callers compose reads and writes with their scopes and
 * error handling during the incremental migration.
 */
export class EffectDocumentStore<T> {
  readonly #store: VersionedDocumentStore<T>;

  constructor(options: VersionedDocumentStoreOptions<T>) {
    this.#store = new VersionedDocumentStore(options);
  }

  get path(): string {
    return this.#store.path;
  }

  readText(): Effect.Effect<string | undefined> {
    return Effect.sync(() => this.#store.readText());
  }

  readResult(): Effect.Effect<DocumentReadResult<T>> {
    return Effect.sync(() => this.#store.readResult());
  }

  read(): Effect.Effect<T | undefined> {
    return Effect.map(this.readResult(), (result) =>
      result.kind === "valid" ? result.value : undefined
    );
  }

  write(value: T): Effect.Effect<string, unknown> {
    return Effect.try({
      try: () => this.#store.write(value),
      catch: (cause) => cause
    });
  }
}

export function makeEffectDocumentStore<T>(
  options: VersionedDocumentStoreOptions<T>
): EffectDocumentStore<T> {
  return new EffectDocumentStore(options);
}
