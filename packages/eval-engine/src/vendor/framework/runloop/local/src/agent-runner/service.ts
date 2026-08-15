import type { Effect, Option, Ref, Stream } from "effect";

import { Context, Schema } from "effect";

import type { HarnessError } from "../../../../contracts/internal/src/errors.ts";
import type { AgentInvocationCore } from "../../../../contracts/internal/src/runtime/command-types.ts";
import type { RuntimeHarness } from "../../../../engine/harness/src/runtime-harness.ts";

import {
  HarnessCapabilityError,
  HarnessProcessError,
  HarnessProtocolError,
  HarnessValidationError,
  RegistryError,
  RuntimeEnvironmentError,
  RuntimeReloadInterruptedError,
  RuntimeSecretError,
  RuntimeServerError,
} from "../../../../contracts/internal/src/errors.ts";

type AgentRunnerError =
  | HarnessError
  | RegistryError
  | RuntimeReloadInterruptedError
  | RuntimeServerError;

type AgentRuntimeEvent =
  ReturnType<RuntimeHarness["invoke"]> extends Stream.Stream<
    infer Event,
    unknown
  >
    ? Event
    : never;
/**
 * The runner-tier invocation: the shared {@link AgentInvocationCore} plus the
 * two placement fields the daemon must have resolved before a run starts.
 * Formerly a second, hand-synced interface also named `InvokeRuntimeCommand`
 * (colliding with the wire command in the contracts tier); it now extends the
 * core so the shared fields are declared once.
 */
export interface AgentRunnerCommand extends AgentInvocationCore {
  readonly cancelState?: Ref.Ref<boolean> | undefined;
  readonly cancelSignal?: Effect.Effect<unknown> | undefined;
  readonly cwd: string;
  /**
   * The features root that owns this invocation. Required: deriving a
   * fallback from `cwd` (a client-controlled value) would anchor skill
   * materialization to whatever directory the client runs from.
   */
  readonly featuresRoot: string;
}

export interface AgentRunnerShape {
  readonly invoke: (
    command: AgentRunnerCommand
  ) => Stream.Stream<AgentRuntimeEvent, AgentRunnerError>;
  readonly invokeRuntime: (
    command: AgentRunnerCommand
  ) => Stream.Stream<AgentRuntimeEvent, AgentRunnerError>;
  readonly invokeCompaction: (
    command: AgentRunnerCommand
  ) => Effect.Effect<
    Option.Option<Stream.Stream<AgentRuntimeEvent, AgentRunnerError>>,
    AgentRunnerError
  >;
}

export class AgentRunner extends Context.Service<
  AgentRunner,
  AgentRunnerShape
>()("ori/runtime/AgentRunner") {}

/** Every concrete error class the {@link AgentRunnerError} union covers. */
const AGENT_RUNNER_ERROR_CLASSES = [
  RegistryError,
  HarnessCapabilityError,
  HarnessProcessError,
  HarnessProtocolError,
  HarnessValidationError,
  RuntimeEnvironmentError,
  RuntimeReloadInterruptedError,
  RuntimeServerError,
  RuntimeSecretError,
] as const;

const AgentRunnerErrorSchema = Schema.Union(AGENT_RUNNER_ERROR_CLASSES);

export const isAgentRunnerError = (error: unknown): error is AgentRunnerError =>
  Schema.is(AgentRunnerErrorSchema)(error);

export type { AgentRunnerError };
