import { Context, Crypto, Effect, Layer, Option } from "effect";

import type { RuntimeHarness } from "../../../../engine/harness/src/runtime-harness.ts";
import type { ImportedAnyContribution } from "../../../local/src/feature-boot/contributions.ts";

import { harness as claudeHarness } from "../../../../builtins/harness-claude/src/feature.ts";
import {
  CLAUDE_COMPACTION_PROMPT,
  readClaudeHarnessAvailabilityDiagnostic,
} from "../../../../builtins/harness-claude/src/harness.ts";
import { harness as piHarness } from "../../../../builtins/harness-pi/src/feature.ts";
import { readPiHarnessAvailabilityDiagnostic } from "../../../../builtins/harness-pi/src/harness/harness.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { HarnessValidationError } from "../../../../contracts/internal/src/errors.ts";
import { HarnessName as HarnessNameSchema } from "../../../../contracts/internal/src/ids.ts";
import { ROUTEKIT_EVAL_BEARER_TOKEN_MISSING_MESSAGE } from "../../../../contracts/internal/src/gateway-auth.ts";
import { RuntimeSecretStore } from "../../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import { RuntimeSecretName } from "../../../../contracts/internal/src/runtime/services.ts";
import { AgentHarnessAdapter } from "../../../../engine/harness/src/adapter.ts";
import { AgentHarnessContributionDecoder } from "../../../../engine/harness/src/contribution-decoder.ts";
import { readRegisteredDefaultModel } from "../../../../engine/harness/src/harness-registration.ts";
import {
  makeLocalRuntimeSecretStore,
  makeRuntimeEnvironment,
} from "../../../../engine/runtime-io/src/runtime-environment.ts";
import { SelectedAdapterCoordinator } from "../../../../engine/selected-adapter/src/coordinator.ts";
import { makeSelectedAdapterRuntimeHarness } from "../../../../engine/selected-adapter/src/runtime-harness.ts";
import { builtInSelectedAdapterNames } from "../selected-adapter.ts";
import {
  codexHarness,
  readCodexHarnessAvailabilityDiagnostic,
} from "../selected-adapter-contributions/codex.ts";
import { makeRuntimeHarnessFromContribution } from "../../../local/src/harness/contribution-runtime.ts";

const BUILT_IN_HARNESS_KIND = "harness";
type HarnessName = RuntimeHarness["name"];

const PI_HARNESS_NAME = HarnessNameSchema.make("pi");
const CLAUDE_HARNESS_NAME = HarnessNameSchema.make("claude");
const CODEX_HARNESS_NAME = HarnessNameSchema.make("codex");
const BUILT_IN_HARNESSES = [
  {
    featureId: "@routekit-eval-builtins/harness-pi",
    sourcePath: "@routekit-eval-builtins/harness-pi/feature.ts",
    harness: piHarness,
    name: PI_HARNESS_NAME,
    compactionPrompt: undefined,
    readAvailability: readPiHarnessAvailabilityDiagnostic,
    telemetryId: "harness-pi",
  },
  {
    featureId: "@routekit-eval-builtins/harness-claude",
    sourcePath: "@routekit-eval-builtins/harness-claude/feature.ts",
    harness: claudeHarness,
    name: CLAUDE_HARNESS_NAME,
    compactionPrompt: CLAUDE_COMPACTION_PROMPT,
    readAvailability: readClaudeHarnessAvailabilityDiagnostic,
    telemetryId: "harness-claude",
  },
  {
    featureId: "@routekit-eval-builtins/harness-codex",
    sourcePath:
      "@routekit-eval-runloop/builtins-catalog/selected-adapter-contributions/codex.ts",
    harness: codexHarness,
    name: CODEX_HARNESS_NAME,
    compactionPrompt: undefined,
    readAvailability: readCodexHarnessAvailabilityDiagnostic,
    telemetryId: "harness-codex",
  },
] as const;

// Bundled harness priority order, highest first (RFC 0006). `pi` leads as the
// bundled default; `claude` and `codex` are the next optimistic fallbacks when
// earlier entries are absent. An `routekit-eval.md` `harness` preference is layered
// ahead of this list at boot.
const BUILT_IN_HARNESS_PRIORITY: readonly HarnessName[] =
  BUILT_IN_HARNESSES.map((entry) => entry.name);

interface BuiltInHarnessCatalogShape {
  readonly availableHarnessNames: readonly HarnessName[];
  readonly defaultHarnessName: HarnessName;
  readonly defaultHarnessPriority: readonly HarnessName[];
  readonly harnessDiagnostics: readonly string[];
  readonly harnesses: readonly ImportedAnyContribution<RuntimeHarness>[];
}

const makeBuiltInHarnessContribution = (
  featureId: string,
  sourcePath: string,
  harness: RuntimeHarness
): ImportedAnyContribution<RuntimeHarness> => ({
  entry: harness,
  featureId,
  kind: BUILT_IN_HARNESS_KIND,
  origin: "builtIn",
  shadows: false,
  sourcePath,
});

interface BuiltInHarnessAvailability {
  readonly availableNames: readonly HarnessName[];
  readonly diagnostics: readonly string[];
}

const formatGatewayKeyDiagnostic = Effect.fn(
  "BuiltInHarnessCatalog.formatGatewayKeyDiagnostic"
)(function* (secrets: ReturnType<typeof makeLocalRuntimeSecretStore>) {
  const key = yield* secrets.get(RuntimeSecretName.GatewayApiKey);
  return Option.isSome(key)
    ? Option.none<string>()
    : Option.some(ROUTEKIT_EVAL_BEARER_TOKEN_MISSING_MESSAGE);
});

const readGatewayKeyDiagnostic = (
  env: NodeJS.ProcessEnv
): Effect.Effect<Option.Option<string>, Error> => {
  const secrets = makeLocalRuntimeSecretStore(makeRuntimeEnvironment(env));
  return formatGatewayKeyDiagnostic(secrets);
};

const readLiveGatewayKeyDiagnostic = Effect.fn(
  "BuiltInHarnessCatalog.gatewayKeyDiagnostic"
)(function* () {
  const secrets = yield* RuntimeSecretStore;
  return yield* formatGatewayKeyDiagnostic(secrets);
});

// The per-harness availability diagnostic returns `None` when the binary is
// present (RFC 0006), so an absent diagnostic means "available".
const readBuiltInHarnessAvailability = Effect.fn(
  "BuiltInHarnessCatalog.harnessAvailability"
)(function* () {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  const harnessDiagnostics = yield* Effect.all(
    BUILT_IN_HARNESSES.map((entry) => entry.readAvailability(env)),
    { concurrency: "unbounded" }
  );
  const gatewayKeyDiagnostic = yield* readLiveGatewayKeyDiagnostic();
  const availableNames = BUILT_IN_HARNESSES.flatMap((entry, index) =>
    Option.isNone(harnessDiagnostics[index]) ? [entry.name] : []
  );
  const diagnostics = [...harnessDiagnostics, gatewayKeyDiagnostic].flatMap(
    (diagnostic) => Option.toArray(diagnostic)
  );

  return {
    availableNames,
    diagnostics,
  } satisfies BuiltInHarnessAvailability;
});

// A harness name with a registered selected adapter runs over ACP through the
// coordinator; every other built-in runs its own in-process contribution. The
// adapter registry is the routing key rather than a field on the contribution,
// so a built-in harness stays exactly the shape a user-authored one has.
const SELECTED_ADAPTER_HARNESS_NAMES: ReadonlySet<string> = new Set(
  builtInSelectedAdapterNames
);

// Initialization only writes registrations down (RFC 0005), so the
// registered default model is readable without ever building the runtime
// harness a selected-adapter catalog entry replaces with an adapter.
const readCatalogDefaultModel = (
  harness: (typeof BUILT_IN_HARNESSES)[number]["harness"]
): Effect.Effect<string | undefined, HarnessValidationError> => {
  if ("init" in harness) {
    return Effect.tryPromise({
      catch: (cause) =>
        new HarnessValidationError({
          cause,
          detail: `Failed to read the registered default model: ${String(cause)}`,
        }),
      try: () => readRegisteredDefaultModel(harness),
    });
  }
  return Effect.succeed(
    "defaultModel" in harness ? harness.defaultModel : undefined
  );
};

const makeBuiltInRuntimeHarness = (input: {
  readonly coordinator: SelectedAdapterCoordinator["Service"];
  readonly crypto: Crypto.Crypto;
  readonly harness: (typeof BUILT_IN_HARNESSES)[number]["harness"];
  readonly compactionPrompt?: string | undefined;
  readonly name: string;
  readonly telemetryId?: RuntimeHarness["telemetryId"];
}): ReturnType<typeof makeRuntimeHarnessFromContribution> =>
  SELECTED_ADAPTER_HARNESS_NAMES.has(input.name)
    ? Effect.gen(function* () {
        const defaultModel = yield* readCatalogDefaultModel(input.harness);
        return makeSelectedAdapterRuntimeHarness({
          contribution: {
            adapter: input.name,
            defaultModel,
            name: input.name,
            compactionPrompt: input.compactionPrompt,
            telemetryId: input.telemetryId,
          },
          coordinator: input.coordinator,
          crypto: input.crypto,
        });
      })
    : makeRuntimeHarnessFromContribution(input.harness).pipe(
        Effect.map((harness) => ({
          ...harness,
          telemetryId: input.telemetryId,
        }))
      );

export class BuiltInHarnessCatalog extends Context.Service<
  BuiltInHarnessCatalog,
  BuiltInHarnessCatalogShape
>()("routekit-eval/runtime/BuiltInHarnessCatalog") {
  static readonly layer = Layer.effect(BuiltInHarnessCatalog)(
    Effect.gen(function* () {
      const coordinator = yield* SelectedAdapterCoordinator;
      const crypto = yield* Crypto.Crypto;
      const harnesses = yield* Effect.all(
        BUILT_IN_HARNESSES.map((entry) =>
          makeBuiltInRuntimeHarness({
            coordinator,
            crypto,
            harness: entry.harness,
            compactionPrompt: entry.compactionPrompt,
            name: entry.name,
            telemetryId: entry.telemetryId,
          }).pipe(
            Effect.map((harness) =>
              makeBuiltInHarnessContribution(
                entry.featureId,
                entry.sourcePath,
                harness
              )
            )
          )
        )
      );
      const availability = yield* readBuiltInHarnessAvailability();

      return BuiltInHarnessCatalog.of({
        availableHarnessNames: availability.availableNames,
        defaultHarnessName: BUILT_IN_HARNESS_PRIORITY[0],
        defaultHarnessPriority: BUILT_IN_HARNESS_PRIORITY,
        harnessDiagnostics: availability.diagnostics,
        harnesses,
      });
    })
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AgentHarnessAdapter.layer,
        AgentHarnessContributionDecoder.layer
      )
    )
  );
}

export {
  BUILT_IN_HARNESSES,
  makeBuiltInRuntimeHarness,
  readGatewayKeyDiagnostic,
};
export type { BuiltInHarnessCatalogShape };
