import type { Layer, PlatformError, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer as LayerModule, Option, Schema } from "effect";

import type {
  CodexNativeConnectionError,
  CodexVersionError,
} from "../../../adapters/adapter-codex-acp/src/errors.ts";
import type { LoggerShape } from "../../../../contracts/internal/src/runtime/services.ts";
import type { AcpAgentConfigError } from "../../../../engine/acp-agent/src/errors.ts";
import type { AcpConnectionConfigError } from "../../../../engine/acp-client/src/errors.ts";
import type { AcpPeer } from "../../../../engine/acp-selected-adapter/src/contribution.ts";
import type {
  SelectedAdapterContribution,
  SelectedAdapterOptions,
} from "../../../../engine/selected-adapter/src/inventory.ts";

import { CodexAdapterConfig as CodexAdapterConfigSchema } from "../../../adapters/adapter-codex-acp/src/config.ts";
import { resolveCodexProcessBinary } from "../../../adapters/adapter-codex-acp/src/native/process-config.ts";
import { makeSelectedCodexAcpPeer } from "../../../adapters/adapter-codex-acp/src/selected-adapter.ts";
import { detectMissingHarnessProcessBinary } from "../../../../contracts/author/src/process-aggregate.ts";
import { HarnessName } from "../../../../contracts/internal/src/ids.ts";
import { RuntimeEnvironment } from "../../../../contracts/internal/src/runtime/runtime-environment.ts";
import { makeAcpSelectedAdapterContribution } from "../../../../engine/acp-selected-adapter/src/contribution.ts";
import {
  makeRuntimeEnvironment,
  RuntimeSecretStoreLive,
} from "../../../../engine/runtime-io/src/runtime-environment.ts";
import { SelectedAdapterError } from "../../../../engine/selected-adapter/src/inventory.ts";

const codexHarness = {
  defaultModel: "gpt-5.3-codex",
} as const;
const CODEX_BINARY_REQUIREMENT = {
  installCommand: "npm install",
} as const;

const readCodexHarnessAvailabilityDiagnostic = Effect.fn(
  "CodexSelectedAdapter.readHarnessAvailabilityDiagnostic"
)(function* (env: NodeJS.ProcessEnv, binary?: string) {
  if (binary !== undefined) {
    return yield* detectMissingHarnessProcessBinary({
      binary,
      env,
      missingBinary: CODEX_BINARY_REQUIREMENT,
    });
  }
  const resolvedBinary = Option.liftThrowable(resolveCodexProcessBinary)();
  return Option.isNone(resolvedBinary)
    ? Option.some(
        "The bundled Codex executable is unavailable. Run `npm install` to restore @openai/codex."
      )
    : Option.none();
});

const readCodexModel = (requestedModel: string | null | undefined): string => {
  const model = requestedModel?.trim();
  return model === undefined || model.length === 0
    ? codexHarness.defaultModel
    : model;
};
const readCodexConfigEnv = (
  env: SelectedAdapterOptions["env"]
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
const decodeCodexConfig = Schema.decodeUnknownEffect(CodexAdapterConfigSchema);

type CodexPeerError =
  | AcpAgentConfigError
  | AcpConnectionConfigError
  | CodexNativeConnectionError
  | CodexVersionError
  | PlatformError.PlatformError
  | SelectedAdapterError;

const makeCodexAcpPeer = (
  options: SelectedAdapterOptions,
  processServices: Layer.Layer<ChildProcessSpawner>,
  logger: LoggerShape
): Effect.Effect<AcpPeer, CodexPeerError, Scope.Scope> => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  };
  const model = readCodexModel(options.model);
  const environmentLayer = LayerModule.succeed(RuntimeEnvironment)(
    RuntimeEnvironment.of(makeRuntimeEnvironment(env))
  );
  const secretsLayer = RuntimeSecretStoreLive.pipe(
    LayerModule.provide(environmentLayer)
  );

  return Effect.gen(function* () {
    const config = yield* decodeCodexConfig({
      cwd: options.cwd,
      env: readCodexConfigEnv(options.env),
      model,
      ...(options.systemPrompt === undefined
        ? {}
        : { systemPrompt: options.systemPrompt }),
    }).pipe(
      Effect.mapError(
        () =>
          new SelectedAdapterError({
            detail: "Invalid Codex selected-adapter configuration",
            reason: "invalid-state",
          })
      )
    );
    return yield* makeSelectedCodexAcpPeer(config, logger, processServices);
  }).pipe(Effect.provide(secretsLayer));
};

const makeCodexSelectedAdapterContribution = (
  logger: LoggerShape,
  processServices: Layer.Layer<ChildProcessSpawner> = NodeServicesLayer
): SelectedAdapterContribution =>
  makeAcpSelectedAdapterContribution({
    displayName: "Codex",
    interactionsEnabled: () => true,
    makePeer: (options) => makeCodexAcpPeer(options, processServices, logger),
    name: HarnessName.make("codex"),
  });

export {
  codexHarness,
  makeCodexSelectedAdapterContribution,
  readCodexHarnessAvailabilityDiagnostic,
  readCodexConfigEnv,
  readCodexModel,
};
