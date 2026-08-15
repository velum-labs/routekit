import { Result, Schema, Terminal } from "effect";
import { CliError } from "effect/unstable/cli";

import { CliOutputAlreadyReported } from "../../contracts/internal/src/cli/cli-output.ts";
import { RouteKitEvalCliExit } from "./cli-exit.ts";

export type CliTelemetryOutcome = "ok" | "help" | "cancelled" | "error";

export const telemetryFailure = (
  result: Result.Result<unknown, unknown>
): unknown => {
  if (Result.isSuccess(result) || result.failure instanceof RouteKitEvalCliExit) {
    return undefined;
  }
  return result.failure;
};

const isShowHelp = (failure: unknown): boolean =>
  Schema.is(CliError.ShowHelp)(failure) ||
  (failure instanceof CliOutputAlreadyReported && isShowHelp(failure.cause));

const isCancelled = (failure: unknown): boolean =>
  Terminal.isQuitError(failure) ||
  (failure instanceof CliOutputAlreadyReported && isCancelled(failure.cause));

export const classifyCliTelemetryOutcome = (input: {
  readonly cancelled?: boolean;
  readonly failure: unknown;
}): CliTelemetryOutcome => {
  if (input.cancelled === true) {
    return "cancelled";
  }
  if (input.failure === undefined) {
    return "ok";
  }
  if (isShowHelp(input.failure)) {
    return "help";
  }
  if (isCancelled(input.failure)) {
    return "cancelled";
  }
  return "error";
};

export const classifyCliExit = (
  failure: unknown
):
  | { readonly _tag: "success" }
  | { readonly _tag: "exit"; readonly code: number }
  | { readonly _tag: "report" } => {
  if (failure === undefined) {
    return { _tag: "success" };
  }
  if (failure instanceof RouteKitEvalCliExit) {
    return {
      _tag: "exit",
      code: failure.exitCode,
    };
  }
  if (
    failure instanceof CliOutputAlreadyReported ||
    Schema.is(CliError.ShowHelp)(failure)
  ) {
    return {
      _tag: "exit",
      code: 1,
    };
  }
  return { _tag: "report" };
};
