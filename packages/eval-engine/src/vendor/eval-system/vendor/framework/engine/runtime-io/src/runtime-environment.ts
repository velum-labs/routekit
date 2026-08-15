import { Effect, Layer, Option, Redacted } from "effect";

import type { RuntimeEnvironmentShape } from "../../../contracts/internal/src/runtime/runtime-environment.ts";
import type { RuntimeSecretStoreShape } from "../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import type {
  RuntimeEnvironmentMap,
  RuntimeSecretValue,
} from "../../../contracts/internal/src/runtime/services.ts";

import { HostProcess } from "../../../contracts/internal/src/cli/host-process.ts";
import {
  RuntimeEnvironmentError,
  RuntimeSecretError,
} from "../../../contracts/internal/src/errors.ts";
import { ROUTEKIT_EVAL_BEARER_TOKEN_ENV } from "../../../contracts/internal/src/gateway-auth.ts";
import { RuntimeEnvironment } from "../../../contracts/internal/src/runtime/runtime-environment.ts";
import { RuntimeSecretStore } from "../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import { RuntimeSecretName } from "../../../contracts/internal/src/runtime/services.ts";

const EMPTY_COUNT = 0;

const makeLocalRuntimeSecretStore = (
  environment: RuntimeEnvironmentShape
): RuntimeSecretStoreShape => ({
  get: (
    name
  ): Effect.Effect<
    Option.Option<RuntimeSecretValue>,
    RuntimeEnvironmentError | RuntimeSecretError
  > => {
    // `RuntimeSecretName` currently has a single member, so a direct
    // `name === RuntimeSecretName.GatewayApiKey` compare narrows to one literal
    // and oxlint flags the `else` as unreachable. Both sides are widened to
    // `string` to keep the load-bearing "unknown secret" fallthrough — a
    // forward-compatibility guard for when more secret names are added.
    const requestedName: string = name;
    if (requestedName === RuntimeSecretName.GatewayApiKey) {
      return environment
        .get(ROUTEKIT_EVAL_BEARER_TOKEN_ENV)
        .pipe(Effect.map(Option.map(Redacted.make)));
    }

    return new RuntimeSecretError({
      detail: "Unknown runtime secret",
      name,
    });
  },
});

const normalizeRuntimeEnvValue = (
  value: string | undefined
): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length !== EMPTY_COUNT ? trimmed : undefined;
};

const optionalRuntimeValue = (
  value: string | undefined
): Option.Option<string> =>
  value === undefined ? Option.none<string>() : Option.some(value);

const getRuntimeEnvironmentValue = (
  name: string,
  readValue: () => string | undefined
): Effect.Effect<Option.Option<string>, RuntimeEnvironmentError> =>
  Effect.try({
    catch: (cause) =>
      new RuntimeEnvironmentError({
        cause,
        detail: `Could not read ${name}`,
        operation: "reading environment value",
      }),
    try: () => optionalRuntimeValue(normalizeRuntimeEnvValue(readValue())),
  });

const makeRuntimeEnvironment = (
  env: RuntimeEnvironmentMap
): RuntimeEnvironmentShape => ({
  get: (name): Effect.Effect<Option.Option<string>, RuntimeEnvironmentError> =>
    getRuntimeEnvironmentValue(name, () => env[name]),
});

const optionalRuntimeSecretValue = (
  value: string | undefined
): Option.Option<RuntimeSecretValue> =>
  value === undefined
    ? Option.none<RuntimeSecretValue>()
    : Option.some(Redacted.make(value));

const makeRuntimeSecretStore = (
  secrets: Partial<Record<RuntimeSecretName, string | undefined>>
): RuntimeSecretStoreShape => ({
  get: (
    name
  ): Effect.Effect<
    Option.Option<RuntimeSecretValue>,
    RuntimeEnvironmentError | RuntimeSecretError
  > =>
    Effect.try({
      catch: (cause) =>
        new RuntimeSecretError({
          cause,
          detail: "Could not read configured secret",
          name,
        }),
      try: () =>
        optionalRuntimeSecretValue(normalizeRuntimeEnvValue(secrets[name])),
    }),
});

/**
 * The live {@link RuntimeEnvironment} adapter. It reads through {@link HostProcess}
 * rather than a private process-global read, so there is one env source across
 * the runtime and a test can inject an environment via `HostProcess.withHome(dir,
 * { env })`. `hostProcess.env` returns the live process env object (not a
 * snapshot), so a value loaded after the layer is built is still visible on a
 * later `get` — the behavior credential loading depends on.
 */
export const RuntimeEnvironmentLive: Layer.Layer<
  RuntimeEnvironment,
  never,
  HostProcess
> = Layer.effect(RuntimeEnvironment)(
  Effect.gen(function* () {
    const hostProcess = yield* HostProcess;
    return RuntimeEnvironment.of({
      get: (name) =>
        hostProcess.env.pipe(
          Effect.flatMap((env) =>
            getRuntimeEnvironmentValue(name, () => env[name])
          )
        ),
    });
  })
);

/**
 * The live {@link RuntimeSecretStore} adapter. Secrets resolve by reading through
 * {@link RuntimeEnvironment} (e.g. the Gateway key from `ROUTEKIT_EVAL_BEARER_TOKEN`),
 * so the store inherits the same live env source and redacts every resolved
 * value.
 */
export const RuntimeSecretStoreLive: Layer.Layer<
  RuntimeSecretStore,
  never,
  RuntimeEnvironment
> = Layer.effect(RuntimeSecretStore)(
  Effect.gen(function* () {
    const environment = yield* RuntimeEnvironment;
    return RuntimeSecretStore.of(makeLocalRuntimeSecretStore(environment));
  })
);

/**
 * A {@link RuntimeSecretStore} seeded from an explicit record rather than the
 * live environment. Used by adapter tests that need the real name-match and
 * normalization path without a live process env; prefer
 * {@link RuntimeSecretStore.layerTest} for a pure stub.
 */
export const runtimeSecretStoreFromRecord = (
  secrets: Partial<Record<RuntimeSecretName, string | undefined>>
): Layer.Layer<RuntimeSecretStore> =>
  Layer.succeed(RuntimeSecretStore)(
    RuntimeSecretStore.of(makeRuntimeSecretStore(secrets))
  );

export {
  makeLocalRuntimeSecretStore,
  makeRuntimeEnvironment,
  makeRuntimeSecretStore,
};
