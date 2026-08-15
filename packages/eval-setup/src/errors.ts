import { Data } from "effect";

export class EvalSetupStateError extends Data.TaggedError("EvalSetupStateError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export class EvalSetupTransitionError extends Data.TaggedError("EvalSetupTransitionError")<{
  readonly stage: string;
  readonly detail: string;
}> {}

export class EvalSetupInspectionError extends Data.TaggedError("EvalSetupInspectionError")<{
  readonly path: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export class EvalSetupScaffoldError extends Data.TaggedError("EvalSetupScaffoldError")<{
  readonly path: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export class EvalSetupRunnerError extends Data.TaggedError("EvalSetupRunnerError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}
