import type { Layer, PlatformError, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer as LayerModule, Schema } from "effect";

import type {
  ClaudeCredentialError,
  ClaudeVersionError,
  ClaudeVersionParseError,
} from "../../../adapters/adapter-claude-acp/src/errors.ts";
import type { ClaudeSessionRegistry } from "../../../adapters/adapter-claude-acp/src/session-registry.ts";
import type { LoggerShape } from "../../../../contracts/internal/src/runtime/services.ts";
import type { AcpAgentConfigError } from "../../../../engine/acp-agent/src/errors.ts";
import type { AcpConnectionConfigError } from "../../../../engine/acp-client/src/errors.ts";
import type { AcpPeer } from "../../../../engine/acp-selected-adapter/src/contribution.ts";
import type {
  SelectedAdapterContribution,
  SelectedAdapterOptions,
} from "../../../../engine/selected-adapter/src/inventory.ts";

import { ClaudeAdapterConfig as ClaudeAdapterConfigSchema } from "../../../adapters/adapter-claude-acp/src/config.ts";
import { makeSelectedClaudeAcpPeer } from "../../../adapters/adapter-claude-acp/src/selected-adapter.ts";
import { makeClaudeSessionRegistry } from "../../../adapters/adapter-claude-acp/src/session-registry.ts";
import { withClaudeSessionState } from "../../../adapters/adapter-claude-acp/src/session-state.ts";
import {
  CLAUDE_DEFAULT_MODEL,
  ROUTEKIT_EVAL_CLAUDE_BIN_ENV,
} from "../../../../builtins/harness-claude/src/harness.ts";
import { HarnessName } from "../../../../contracts/internal/src/ids.ts";
import { RuntimeEnvironment } from "../../../../contracts/internal/src/runtime/runtime-environment.ts";
import { makeAcpSelectedAdapterContribution } from "../../../../engine/acp-selected-adapter/src/contribution.ts";
import {
  makeRuntimeEnvironment,
  RuntimeSecretStoreLive,
} from "../../../../engine/runtime-io/src/runtime-environment.ts";
import { SelectedAdapterError } from "../../../../engine/selected-adapter/src/inventory.ts";

const CLAUDE_BINARY = "claude";

type ClaudePeerError =
  | AcpAgentConfigError
  | AcpConnectionConfigError
  | ClaudeCredentialError
  | ClaudeVersionError
  | ClaudeVersionParseError
  | PlatformError.PlatformError
  | SelectedAdapterError;

const readClaudeCommand = (env: NodeJS.ProcessEnv): string => {
  const override = env[ROUTEKIT_EVAL_CLAUDE_BIN_ENV]?.trim();
  return override !== undefined && override.length > 0
    ? override
    : CLAUDE_BINARY;
};

const decodeClaudeConfig = Schema.decodeUnknownEffect(
  ClaudeAdapterConfigSchema
);

const makeClaudeAcpPeer = (input: {
  readonly logger: LoggerShape;
  readonly options: SelectedAdapterOptions;
  readonly processServices: Layer.Layer<ChildProcessSpawner>;
  readonly sessions: ClaudeSessionRegistry;
}): Effect.Effect<AcpPeer, ClaudePeerError, Scope.Scope> => {
  const { logger, options, processServices, sessions } = input;
  // Claude owns a different native lifecycle from Pi, so process setup stays
  // harness-specific while the shared contribution owns the ACP bridge.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  };
  const requestedModel = options.model?.trim();
  const model =
    requestedModel !== undefined && requestedModel.length > 0
      ? requestedModel
      : CLAUDE_DEFAULT_MODEL;
  const environmentLayer = LayerModule.succeed(RuntimeEnvironment)(
    RuntimeEnvironment.of(makeRuntimeEnvironment(env))
  );
  const secretsLayer = RuntimeSecretStoreLive.pipe(
    LayerModule.provide(environmentLayer)
  );

  return Effect.gen(function* () {
    const pluginDirs = options.extraSkillDirs?.filter(
      (dir) => dir.trim().length > 0
    );
    const config = yield* decodeClaudeConfig({
      claudeCommand: readClaudeCommand(env),
      cwd: options.cwd,
      model,
      ...(options.parameters === undefined
        ? {}
        : { parameters: options.parameters }),
      ...(pluginDirs === undefined || pluginDirs.length === 0
        ? {}
        : { pluginDirs }),
      ...(options.systemPrompt === undefined
        ? {}
        : { systemPrompt: options.systemPrompt }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SelectedAdapterError({
            detail: `Invalid Claude selected-adapter configuration: ${cause.message}`,
            reason: "invalid-state",
          })
      )
    );
    return yield* makeSelectedClaudeAcpPeer({
      config,
      diagnosticsLogger: logger,
      processServices,
      sessions,
    });
  }).pipe(Effect.provide(secretsLayer));
};

const makeClaudeSelectedAdapterContribution = (
  logger: LoggerShape,
  processServices: Layer.Layer<ChildProcessSpawner> = NodeServicesLayer
): SelectedAdapterContribution => {
  const sessions = makeClaudeSessionRegistry();
  return withClaudeSessionState(
    makeAcpSelectedAdapterContribution({
      displayName: "Claude",
      interactionsEnabled: () => true,
      makePeer: (options) =>
        makeClaudeAcpPeer({
          logger,
          options,
          processServices,
          sessions,
        }),
      name: HarnessName.make("claude"),
    }),
    sessions
  );
};

export { makeClaudeSelectedAdapterContribution };
