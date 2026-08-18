import type { Crypto, Stream } from "effect";

import type { TelemetryObserverShape } from "../../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { RuntimeEventJournalShape } from "../../../../../engine/events/src/event-journal-service.ts";
import type { AgentSessionStoreShape } from "../../../../../engine/session/src/session-store-service.ts";
import type { AgentRunnerShape } from "../../agent-runner/service.ts";
import type { DaemonAddressShape } from "./address.ts";
import type { DaemonAuditLoggerShape } from "./audit-logger.ts";
import type { OriDaemonShape } from "./service.ts";
import type { RolloverConfig } from "../../event/rollover.ts";
import type { ContextWindowLookup } from "../../models/context-window.ts";
import type { OpenRouterModels } from "../../openrouter/models-service.ts";
import type { ReloadCoordinatorShape } from "../../reload/coordinator.ts";

/**
 * Command/event types derived from the daemon contract plus the service
 * bundle the invoke path threads through. They live apart from daemon-invoke
 * so collaborators like rollover-stream can consume them without importing
 * the invoke orchestration itself (which imports those collaborators back).
 */

export type RuntimeCommand = Parameters<OriDaemonShape["invoke"]>[0];
export type RuntimeStreamEvent =
  ReturnType<OriDaemonShape["invoke"]> extends Stream.Stream<
    infer Event,
    unknown
  >
    ? Event
    : never;
export type AgentRuntimeEvent = Extract<
  RuntimeStreamEvent,
  { readonly type: "runtime.event" }
>["event"];
export interface OriDaemonServices {
  readonly crypto: Crypto.Crypto;
  /** The daemon's own base URL once serving; rollover seeds absolute API links from it. */
  readonly daemonAddress: DaemonAddressShape;
  readonly defaultCwd: string;
  readonly defaultFeaturesRoot?: string | undefined;
  readonly journal: RuntimeEventJournalShape;
  readonly logger: DaemonAuditLoggerShape;
  /**
   * Context-window lookup for the rollover path. Daemon-lifetime so its catalog
   * cache is shared across turns but owned by this daemon, not by the module.
   */
  readonly contextWindowLookup: ContextWindowLookup["Service"];
  /** Catalog service backing the context-window lookup on the rollover path. */
  readonly openRouterModels: OpenRouterModels["Service"];
  readonly reloadCoordinator: ReloadCoordinatorShape;
  /** Rollover compaction policy (ORI-471), env-resolved at daemon boot. */
  readonly rollover: RolloverConfig;
  readonly runner: AgentRunnerShape;
  readonly sessionStore: AgentSessionStoreShape;
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
}
