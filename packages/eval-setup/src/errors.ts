import { Data } from "effect";

export class EvalSetupStateError extends Data.TaggedError("EvalSetupStateError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `RouteKit Eval setup could not ${this.operation}: ${this.detail}`;
  }
}

export class EvalSetupTransitionError extends Data.TaggedError("EvalSetupTransitionError")<{
  readonly stage: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `RouteKit Eval setup cannot continue from ${this.stage}: ${this.detail}`;
  }
}

export class EvalSetupInspectionError extends Data.TaggedError("EvalSetupInspectionError")<{
  readonly path: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `RouteKit Eval could not inspect ${this.path}: ${this.detail}`;
  }
}

export class EvalSetupScaffoldError extends Data.TaggedError("EvalSetupScaffoldError")<{
  readonly path: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `RouteKit Eval could not scaffold ${this.path}: ${this.detail}`;
  }
}

export class EvalSetupRunnerError extends Data.TaggedError("EvalSetupRunnerError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `RouteKit Eval setup could not ${this.operation}: ${this.detail}`;
  }
}
