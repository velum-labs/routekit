import { Data, Runtime } from "effect";

/**
 * A request to terminate the `routekit-eval` process with a specific exit code, carried
 * through the Effect error channel to the runtime teardown rather than via a
 * a manual process-exit syscall.
 *
 * `runMain`'s `defaultTeardown` reads {@link Runtime.errorExitCode} off the
 * squashed failure to set the process exit code, and {@link Runtime.errorReported}
 * (`false`) suppresses the pretty error log — this is a *deliberate* exit, not a
 * crash. `bin/routekit-eval.ts` is the outer `runMain` edge that turns the CLI's resolved
 * numeric exit code into this failure; {@link runRouteKitEvalCli} surfaces it unflattened
 * so a deep command (e.g. the dev dependency-install re-exec) can propagate an
 * exact child exit code instead of the generic `1`.
 */
export class RouteKitEvalCliExit extends Data.TaggedError("RouteKitEvalCliExit")<{
  readonly exitCode: number;
}> {
  readonly [Runtime.errorExitCode] = this.exitCode;
  readonly [Runtime.errorReported] = false;
}
