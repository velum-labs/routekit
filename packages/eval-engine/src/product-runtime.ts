import { Layer, Option } from "effect";

import type { TelemetryUsageSinkShape } from "./vendor/framework/contracts/internal/src/runtime/telemetry-usage-sink.ts";
import type { OriDaemonLayerOptions } from "./vendor/framework/runloop/local/src/daemon/core/index.ts";
import type { EvalRuntimeIoLayers } from "./product-catalog.ts";

import { TelemetryObserver } from "./vendor/framework/contracts/internal/src/runtime/telemetry-observer.ts";
import { agentSessionStoreLayer } from "./vendor/framework/engine/session/src/session-store.ts";
import { DaemonAddress } from "./vendor/framework/runloop/local/src/daemon/core/address.ts";
import { makeOriDaemonLayer } from "./vendor/framework/runloop/local/src/daemon/core/index.ts";
import { DevLogStoreLive } from "./vendor/framework/runloop/local/src/dev/log-store-live.ts";
import { runtimeEventJournalLayer } from "./vendor/framework/runloop/local/src/event/journal-layer.ts";
import { makeDaemonObservabilityLayer } from "./vendor/framework/runloop/local/src/logging/support.ts";
import { ReloadCoordinator } from "./vendor/framework/runloop/local/src/reload/coordinator.ts";
import { nodeServicesLayer } from "./vendor/framework/runloop/local/src/runtime/io-layer.ts";

import { makeEvalAgentRunnerLayer } from "./product-catalog";

const daemonDependenciesLayer = Layer.mergeAll(
  makeEvalAgentRunnerLayer().pipe(Layer.provideMerge(TelemetryObserver.layer)),
  runtimeEventJournalLayer,
  agentSessionStoreLayer,
  DaemonAddress.layer,
  ReloadCoordinator.layer,
  DevLogStoreLive().pipe(Layer.provide(nodeServicesLayer)),
).pipe(Layer.provideMerge(makeDaemonObservabilityLayer({}).pipe(Layer.provide(nodeServicesLayer))));

export interface EvalDaemonDependenciesOptions {
  readonly authSource?: OriDaemonLayerOptions["authSource"];
  readonly devLogWorkspaceRoot?: string | undefined;
  readonly externalSkillsRoot?: string | undefined;
  readonly featuresRoot?: string | undefined;
  readonly suppressAuditStdout?: boolean | undefined;
  readonly telemetryObserverLayer?: Layer.Layer<TelemetryObserver>;
  readonly telemetryUsageSink?: TelemetryUsageSinkShape | undefined;
  readonly suppressTuiLogs?: boolean | undefined;
  readonly runtimeIo?: EvalRuntimeIoLayers;
}

export const makeEvalDaemonDependenciesLayer = (
  options?: EvalDaemonDependenciesOptions,
): typeof daemonDependenciesLayer => {
  const runnerLayer = makeEvalAgentRunnerLayer(
    options?.externalSkillsRoot,
    options?.runtimeIo,
  );
  return Layer.mergeAll(
    runnerLayer.pipe(
      Layer.provideMerge(options?.telemetryObserverLayer ?? TelemetryObserver.layer),
    ),
    runtimeEventJournalLayer,
    agentSessionStoreLayer,
    DaemonAddress.layer,
    ReloadCoordinator.layer,
    DevLogStoreLive(options?.featuresRoot, options?.devLogWorkspaceRoot).pipe(
      Layer.provide(nodeServicesLayer),
    ),
  ).pipe(
    Layer.provideMerge(
      makeDaemonObservabilityLayer({
        suppressAuditStdout: options?.suppressAuditStdout,
        telemetryUsageSink: options?.telemetryUsageSink,
        suppressTuiLogs: options?.suppressTuiLogs,
      }).pipe(Layer.provide(nodeServicesLayer)),
    ),
  );
};

type EvalDaemonService = Layer.Success<ReturnType<typeof makeOriDaemonLayer>>;

export const makeProvidedEvalDaemonLayer = (
  dependencies: typeof daemonDependenciesLayer = daemonDependenciesLayer,
  options?: EvalDaemonDependenciesOptions,
): Layer.Layer<EvalDaemonService, Layer.Error<typeof daemonDependenciesLayer>> =>
  makeOriDaemonLayer({
    authSource: options?.authSource ?? Option.none(),
    featuresRoot: options?.featuresRoot,
  }).pipe(Layer.provide(Layer.mergeAll(nodeServicesLayer, dependencies)));
