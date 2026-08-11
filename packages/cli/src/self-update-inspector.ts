export {
  SelfUpdateInspectionError,
  diagnosticTail,
  redactDiagnostic
} from "./self-update/diagnostics.js";
export {
  inspectSelfUpdateInstallation,
  performSelfUpdate,
  remediationCommand
} from "./self-update/perform.js";
export { defaultRunner } from "./self-update/runner.js";
export {
  ROUTEKIT_PACKAGE_NAME,
  type CommandInvocation,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
  type DiscoveryContext,
  type InspectOptions,
  type InstallationInspection,
  type InstallOwner,
  type NpmOwner,
  type PnpmOwner,
  type RouteKitCandidate,
  type SelfUpdateOptions,
  type SelfUpdateResult
} from "./self-update/types.js";
