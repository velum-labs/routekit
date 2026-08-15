import type { Layer, PlatformError, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer as LayerModule } from "effect";

import type { PiAdapterConfig } from "../../../adapters/adapter-pi-acp/src/config.ts";
import type { PiCredentialError } from "../../../adapters/adapter-pi-acp/src/errors.ts";
import type { PiSessionRegistry } from "../../../adapters/adapter-pi-acp/src/selected-adapter.ts";
import type { LoggerShape } from "../../../../contracts/internal/src/runtime/services.ts";
import type { AcpAgentConfigError } from "../../../../engine/acp-agent/src/errors.ts";
import type { AcpConnectionConfigError } from "../../../../engine/acp-client/src/errors.ts";
import type { AcpPeer } from "../../../../engine/acp-selected-adapter/src/contribution.ts";
import type {
  SelectedAdapterContribution,
  SelectedAdapterOptions,
} from "../../../../engine/selected-adapter/src/inventory.ts";

import { makePiRetryingSelectedAdapterContribution } from "../../../adapters/adapter-pi-acp/src/retry.ts";
import {
  makePiSessionRegistry,
  makeSelectedPiAcpPeer,
} from "../../../adapters/adapter-pi-acp/src/selected-adapter.ts";
import { withPiSessionState } from "../../../adapters/adapter-pi-acp/src/session-state.ts";
import {
  piRetrySupport,
  preparePiAcpLaunch,
} from "../../../../builtins/harness-pi/src/acp/prepare.ts";
import { HarnessName } from "../../../../contracts/internal/src/ids.ts";
import { RuntimeEnvironment } from "../../../../contracts/internal/src/runtime/runtime-environment.ts";
import { makeAcpSelectedAdapterContribution } from "../../../../engine/acp-selected-adapter/src/contribution.ts";
import {
  makeRuntimeEnvironment,
  RuntimeSecretStoreLive,
} from "../../../../engine/runtime-io/src/runtime-environment.ts";
import { SelectedAdapterError } from "../../../../engine/selected-adapter/src/inventory.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

// The typed failures Pi's peer setup can surface; the shared contribution
// factory normalizes every one (and any defect) into a `SelectedAdapterError`.
type PiPeerError =
  | AcpAgentConfigError
  | AcpConnectionConfigError
  | PiCredentialError
  | PlatformError.PlatformError
  | SelectedAdapterError;

// Acquires the launch plan from Pi's ordinary feature contribution and keeps
// its cleanup in the same scope as the ACP peer. This composition root only
// joins the author-facing launch plan to the internal selected adapter.
const makePiAcpPeer = (input: {
  readonly logger: LoggerShape;
  readonly options: SelectedAdapterOptions;
  readonly processServices: Layer.Layer<ChildProcessSpawner>;
  readonly sessions: PiSessionRegistry;
}): Effect.Effect<AcpPeer, PiPeerError, Scope.Scope> => {
  const { logger, options, processServices, sessions } = input;
  const env: NodeJS.ProcessEnv = {
    ...globalThis.process.env,
    ...options.env,
  };
  const environmentLayer = LayerModule.succeed(RuntimeEnvironment)(
    RuntimeEnvironment.of(makeRuntimeEnvironment(env))
  );
  const secretsLayer = RuntimeSecretStoreLive.pipe(
    LayerModule.provide(environmentLayer)
  );

  return Effect.gen(function* () {
    // Pi's own feature owns the launch plan, so the adapter falls back to it
    // rather than requiring the harness contribution to carry a `prepare`.
    // That keeps the built-in harness the same shape as a user-authored one.
    const prepare = options.prepare ?? preparePiAcpLaunch;
    const launch = yield* Effect.tryPromise({
      catch: (cause) =>
        new SelectedAdapterError({
          detail: formatUnknownError(cause),
          reason: "invalid-state",
        }),
      try: () =>
        prepare({
          contextWindow: options.contextWindow,
          cwd: options.cwd,
          env: options.env ?? {},
          extraSkillDirs: options.extraSkillDirs,
          parameters: options.parameters,
          model: options.model,
          systemPrompt: options.systemPrompt,
        }),
    });
    if (launch.dispose !== undefined) {
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => launch.dispose?.() ?? Promise.resolve())
      );
    }
    const piConfig: PiAdapterConfig = {
      args: [...launch.args],
      cwd: launch.cwd,
      env: Object.fromEntries(
        Object.entries(launch.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      piCommand: launch.command,
    };
    return yield* makeSelectedPiAcpPeer({
      config: piConfig,
      diagnosticsLogger: logger,
      processServices,
      sessions,
    });
  }).pipe(Effect.provide(secretsLayer));
};

const makePiSelectedAdapterContribution = (
  logger: LoggerShape,
  processServices: Layer.Layer<ChildProcessSpawner> = NodeServicesLayer
): SelectedAdapterContribution => {
  const sessions = makePiSessionRegistry();
  const contribution = makeAcpSelectedAdapterContribution({
    displayName: "Pi",
    interactionsEnabled: () => true,
    makePeer: (options) =>
      makePiAcpPeer({
        logger,
        options,
        processServices,
        sessions,
      }),
    name: HarnessName.make("pi"),
  });
  return withPiSessionState(
    makePiRetryingSelectedAdapterContribution(contribution, piRetrySupport),
    sessions
  );
};

export { makePiSelectedAdapterContribution };
