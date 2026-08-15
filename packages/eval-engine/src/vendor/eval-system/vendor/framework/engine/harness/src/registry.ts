import { Context, Effect } from "effect";

import { RegistryError } from "../../../contracts/internal/src/errors.ts";

import type { RuntimeHarness } from "./runtime-harness.ts";

const HARNESS_REGISTRY_KIND = "harness";

type HarnessName = RuntimeHarness["name"];

interface HarnessRegistryEntry {
  readonly name: HarnessName;
  readonly value: RuntimeHarness;
}

interface HarnessRegistryShape {
  readonly default: Effect.Effect<RuntimeHarness, RegistryError>;
  readonly entries: readonly HarnessRegistryEntry[];
  readonly get: (
    name: HarnessName
  ) => Effect.Effect<RuntimeHarness, RegistryError>;
  readonly kind: string;
}

class HarnessRegistry extends Context.Service<
  HarnessRegistry,
  HarnessRegistryShape
>()("routekit-eval/runtime/HarnessRegistry") {}

const lookupHarness =
  (byName: ReadonlyMap<HarnessName, RuntimeHarness>) =>
  (name: HarnessName): Effect.Effect<RuntimeHarness, RegistryError> => {
    const value = byName.get(name);
    if (value === undefined) {
      return new RegistryError({
        kind: HARNESS_REGISTRY_KIND,
        name,
      });
    }
    return Effect.succeed(value);
  };

const makeHarnessRegistryEntries = (
  harnesses: readonly RuntimeHarness[]
): readonly HarnessRegistryEntry[] =>
  harnesses.map((harness) => ({
    name: harness.name,
    value: harness,
  }));

export const makeHarnessRegistry = (
  harnesses: readonly RuntimeHarness[],
  defaultHarness: Effect.Effect<RuntimeHarness, RegistryError>
): HarnessRegistryShape => {
  const entries = makeHarnessRegistryEntries(harnesses);
  const byName = new Map(
    entries.map((entry) => [entry.name, entry.value] as const)
  );

  return HarnessRegistry.of({
    default: defaultHarness,
    entries,
    get: lookupHarness(byName),
    kind: HARNESS_REGISTRY_KIND,
  });
};

export const makeStaticHarnessRegistry = (
  harnesses: readonly RuntimeHarness[],
  defaultName: HarnessName
): HarnessRegistryShape => {
  const byName = new Map(
    makeHarnessRegistryEntries(harnesses).map(
      (entry) => [entry.name, entry.value] as const
    )
  );
  return makeHarnessRegistry(harnesses, lookupHarness(byName)(defaultName));
};

export { HARNESS_REGISTRY_KIND, HarnessRegistry };
export type { HarnessRegistryShape };
