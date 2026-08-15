import { Effect } from "effect";

import { RegistryError } from "../../../contracts/internal/src/errors.ts";

export interface RegistryEntry<A, Name extends string = string> {
  readonly name: Name;
  readonly value: A;
}

/**
 * The generic per-capability-kind registry (RFC 0003). Holds every contribution
 * of one kind, addressable by name. Provider kinds resolve a single entry via
 * `default` or `get`; aggregate kinds read `entries` directly.
 *
 * `default` resolves the entry whose name matches the configured default name.
 * Full RFC 0006 default-selection precedence (shadowing tiers, project-over-
 * builtin, ambiguity) is out of scope here and layers on top of this shape.
 */
export interface Registry<A, Name extends string = string> {
  readonly default: Effect.Effect<A, RegistryError>;
  readonly entries: readonly RegistryEntry<A, Name>[];
  readonly getEntry: (
    name: Name
  ) => Effect.Effect<RegistryEntry<A, Name>, RegistryError>;
  readonly get: (name: Name) => Effect.Effect<A, RegistryError>;
  readonly kind: string;
}

export interface RegistryLookup<A, Name extends string = string> {
  readonly entries: readonly RegistryEntry<A, Name>[];
  readonly getEntry: (
    name: Name
  ) => Effect.Effect<RegistryEntry<A, Name>, RegistryError>;
  readonly get: (name: Name) => Effect.Effect<A, RegistryError>;
  readonly kind: string;
}

export interface MakeRegistryOptions<A, Name extends string = string> {
  readonly defaultName: Name;
  readonly entries: readonly RegistryEntry<A, Name>[];
  readonly kind: string;
}

export interface MakeRegistryLookupOptions<A, Name extends string = string> {
  readonly entries: readonly RegistryEntry<A, Name>[];
  readonly kind: string;
}

export const makeRegistryLookup = <A, Name extends string = string>(
  options: MakeRegistryLookupOptions<A, Name>
): RegistryLookup<A, Name> => {
  const byName = new Map(
    options.entries.map((entry) => [entry.name, entry] as const)
  );

  const getEntry = (
    name: Name
  ): Effect.Effect<RegistryEntry<A, Name>, RegistryError> => {
    const entry = byName.get(name);
    if (entry === undefined) {
      return new RegistryError({
        kind: options.kind,
        name,
      });
    }
    return Effect.succeed(entry);
  };
  const get = (name: Name): Effect.Effect<A, RegistryError> =>
    getEntry(name).pipe(Effect.map((entry) => entry.value));

  return {
    entries: options.entries,
    getEntry,
    get,
    kind: options.kind,
  };
};

export const makeRegistry = <A, Name extends string = string>(
  options: MakeRegistryOptions<A, Name>
): Registry<A, Name> => {
  const lookup = makeRegistryLookup(options);

  return {
    ...lookup,
    default: lookup.get(options.defaultName),
  };
};
