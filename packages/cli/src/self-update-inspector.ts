export {
  diagnosticTail,
  redactDiagnostic,
  SelfUpdateInspectionError
} from "./self-update/diagnostics.js";
export {
  inspectSelfUpdateInstallation,
  performSelfUpdate,
  remediationCommand
} from "./self-update/perform.js";
export { defaultRunner } from "./self-update/runner.js";
export {
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
  type CommandRunOptions,
  type DiscoveryContext,
  type InspectOptions,
  type InstallationInspection,
  type InstallOwner,
  type NpmOwner,
  type PnpmOwner,
  ROUTEKIT_PACKAGE_NAME,
  type RouteKitCandidate,
  type SelfUpdateOptions,
  type SelfUpdateResult
} from "./self-update/types.js";
