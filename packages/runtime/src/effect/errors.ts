import { Cause, Data, Exit } from "effect";

/**
 * Tagged failure for Effect-native RouteKit programs.
 *
 * Promise-boundary helpers still preserve existing `Error` subclasses
 * (`ControlError`, `UnknownModelError`) so wire translation stays exact.
 */
export class RouteKitFailure extends Data.TaggedError("RouteKitFailure")<{
  readonly message: string;
}> {}

/** Convert an Effect exit into the Promise-style value/error convention. */
export function throwRouteKitExit<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  // `Cause.prettyErrors` intentionally renders/clones `Error` values. At a
  // Promise boundary we should preserve the original typed failure object
  // whenever possible (callers often use identity checks or custom fields).
  const errors = exit.cause.reasons.map((reason) => {
    if (Cause.isFailReason(reason)) return routeKitError(reason.error);
    return (
      Cause.prettyErrors(Cause.fromReasons([reason]))[0] ?? new Error(Cause.pretty(exit.cause))
    );
  });
  if (errors.length === 1 && errors[0] !== undefined) throw errors[0];
  throw new AggregateError(errors, Cause.pretty(exit.cause));
}

/** Convert an unknown failure into an Error without losing useful text. */
export function routeKitError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new RouteKitFailure({
    message: typeof cause === "string" ? cause : String(cause)
  });
}
