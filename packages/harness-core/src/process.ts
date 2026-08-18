/**
 * The process runtime drivers build on, re-exported so a driver package
 * depends only on `@velum-labs/routekit-harness-core`: allowlisted child envs, capture
 * runs with group-kill + SIGTERM->SIGKILL escalation, logged long-lived
 * children, readiness helpers, and port allocation.
 */
export {
  runCliCapture,
  spawnLogged,
  terminate,
  waitForHttp,
  waitForOutput
} from "@velum-labs/routekit-runtime/process";
export { buildChildEnv } from "@velum-labs/routekit-runtime/environment";
export { freePort } from "@velum-labs/routekit-runtime/ports";
export { withDeadline, withTimeout } from "@velum-labs/routekit-runtime/timing";
export type {
  CliCaptureOptions,
  CliCaptureResult,
  LoggedChild,
  LoggedSpawnOptions
} from "@velum-labs/routekit-runtime/process";
export type { BuildChildEnvInput } from "@velum-labs/routekit-runtime/environment";
