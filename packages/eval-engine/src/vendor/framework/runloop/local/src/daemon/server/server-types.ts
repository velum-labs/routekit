/**
 * Shared request-context and runtime types for the daemon HTTP server.
 *
 * Extracted into a leaf module so that route handlers (e.g.
 * `daemon-server-dev-schedule`) and the CLI's session plumbing can depend on
 * these types without importing the `daemon-server` module itself — which
 * would otherwise form an import cycle (`daemon-server` imports the dispatch
 * *value* from `daemon-server-dev-schedule`, which imports this *type* back
 * from `daemon-server`) and, for the CLI consumers, a value edge onto the
 * server for what is purely a type dependency.
 */
import type { Config, ManagedRuntime, PlatformError } from "effect";

import type {
  HarnessValidationError,
  RuntimeEnvironmentError,
  RuntimeSecretError,
  RuntimeServerError,
} from "../../../../../contracts/internal/src/errors.ts";
import type { RuntimeEventJournal } from "../../../../../engine/events/src/event-journal-service.ts";
import type { SelectedAdapterCoordinator } from "../../../../../engine/selected-adapter/src/coordinator.ts";
import type { AgentSessionStore } from "../../../../../engine/session/src/session-store-service.ts";
import type { AgentInvokeCell } from "../../agent/invoke-cell.ts";
import type { FeatureCatalog } from "../../catalog/feature.ts";
import type { DaemonAddress } from "../core/address.ts";
import type { OriDaemon } from "../core/service.ts";
import type { DaemonLogHub } from "../logging/log-hub.ts";
import type { DevLogStore } from "../../dev/log-store.ts";
import type { FeatureRuntime } from "../../feature-runtime/service.ts";
import type { ReloadCoordinator } from "../../reload/coordinator.ts";

/** Every service the daemon's ManagedRuntime must provide to its routes. */
export type DaemonRuntimeServices =
  | AgentInvokeCell
  | AgentSessionStore
  | DaemonAddress
  | DaemonLogHub
  | DevLogStore
  | FeatureRuntime
  | FeatureCatalog
  | OriDaemon
  | ReloadCoordinator
  | SelectedAdapterCoordinator
  | RuntimeEventJournal;

/**
 * The ManagedRuntime the daemon server runs requests inside. Its error channel
 * is spelled out here rather than derived from the product composition, so
 * this leaf module stays independent of the product root. The product-side
 * runtime factory must remain assignable to this contract, which keeps newly
 * introduced dependency errors visible at the composition boundary.
 */
export type DaemonRuntime = ManagedRuntime.ManagedRuntime<
  DaemonRuntimeServices,
  | Config.ConfigError
  | Error
  | HarnessValidationError
  | PlatformError.PlatformError
  | RuntimeEnvironmentError
  | RuntimeSecretError
  | RuntimeServerError
>;

export interface DaemonRequestContext {
  readonly enableDevRoutes: boolean;
  readonly featuresRoot?: string | undefined;
  readonly host: string;
  readonly port: number;
  /**
   * The caller's remote IP address as reported by the server, when available.
   * Forwarded into feature api route contexts (RFC 0002 api.md) so internal
   * routes can enforce a loopback-only trust boundary in-handler.
   */
  readonly remoteAddress?: string | undefined;
}
