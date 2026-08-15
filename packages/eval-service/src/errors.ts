import { Data } from "effect";

type EvalServiceFailureFields = {
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
};

abstract class EvalServiceFailure extends Data.Error<EvalServiceFailureFields> {
  override get message(): string {
    return `RouteKit Eval could not ${this.operation}: ${this.detail}`;
  }
}

export class EvalServiceConfigurationError extends Data.TaggedError(
  "EvalServiceConfigurationError"
)<EvalServiceFailureFields> {
  override get message(): string {
    return `RouteKit Eval configuration is invalid: ${this.detail}`;
  }
}

export class EvalServiceValidationError extends Data.TaggedError(
  "EvalServiceValidationError"
)<EvalServiceFailureFields> {
  override get message(): string {
    return `RouteKit Eval validation failed: ${this.detail}`;
  }
}

export class EvalServiceEstimateError extends Data.TaggedError(
  "EvalServiceEstimateError"
)<EvalServiceFailureFields> {
  override get message(): string {
    return `RouteKit Eval estimate failed: ${this.detail}`;
  }
}

export class EvalServiceComparisonError extends Data.TaggedError(
  "EvalServiceComparisonError"
)<EvalServiceFailureFields> {
  override get message(): string {
    return `RouteKit Eval comparison failed: ${this.detail}`;
  }
}

export class EvalServicePolicyError extends Data.TaggedError(
  "EvalServicePolicyError"
)<EvalServiceFailureFields> {
  override get message(): string {
    return `RouteKit Eval policy compilation failed: ${this.detail}`;
  }
}

export class EvalServicePublicationError extends Data.TaggedError(
  "EvalServicePublicationError"
)<EvalServiceFailureFields> {
  override get message(): string {
    return `RouteKit Eval policy publication failed: ${this.detail}`;
  }
}
