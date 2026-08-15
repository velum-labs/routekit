import type { Context, Effect } from "effect";

import { Effect as EffectRuntime } from "effect";

import type { StateStore, StoreResolver } from "../../../../contracts/author/src/index.ts";
import type { RegistryError } from "../../../../contracts/internal/src/errors.ts";

const missingStateValue: string | undefined = undefined;

interface AuthorStoreRegistries {
  readonly dbRegistry: {
    readonly get: (name: string) => Effect.Effect<StateStore, RegistryError>;
  };
}

export const fallbackAuthorStateStore: StateStore = {
  exec: () => Promise.resolve(),
  get: () => Promise.resolve(missingStateValue),
  name: "fallback",
  query: <Row = unknown>() => Promise.resolve([] as readonly Row[]),
  set: () => Promise.resolve(),
};

export const makeAuthorStoreResolver = (
  context: Context.Context<never>,
  registries: AuthorStoreRegistries,
  state: StateStore
): StoreResolver => {
  const runPromise = EffectRuntime.runPromiseWith(context);
  return {
    db: (name) => runPromise(registries.dbRegistry.get(name)),
    state,
  };
};
