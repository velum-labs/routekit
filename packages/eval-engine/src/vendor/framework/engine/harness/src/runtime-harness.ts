import type { Effect, Option, Stream } from "effect";

import type { AgentInteractionResponse } from "../../../contracts/author/src/index.ts";
import type { HarnessError } from "../../../contracts/internal/src/errors.ts";
import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event-types.ts";
import type { AgentHarnessTelemetryId } from "../../../contracts/internal/src/runtime/telemetry-harness.ts";
import type {
  RuntimeHarnessCompactionOptions,
  RuntimeHarnessInvokeOptions,
} from "./options.ts";

type HarnessName = AgentRuntimeEvent["harness"];
type SessionId = NonNullable<AgentRuntimeEvent["sessionId"]>;

export type { AgentHarnessTelemetryId };

export type RuntimeHarnessCompaction = (
  options: RuntimeHarnessCompactionOptions
) => Stream.Stream<AgentRuntimeEvent, HarnessError>;

export interface RuntimeHarness {
  readonly initialize?: Effect.Effect<void, HarnessError>;
  readonly close: Effect.Effect<void, HarnessError>;
  readonly compact: Effect.Effect<
    Option.Option<RuntimeHarnessCompaction>,
    HarnessError
  >;
  /**
   * The model this harness runs when a turn supplies none; surfaced so a
   * surface can show the active model before the first turn reports it. See
   * the harness registrar's `setDefaultModel` callback.
   */
  readonly defaultModel?: string | undefined;
  readonly invoke: (
    options: RuntimeHarnessInvokeOptions
  ) => Stream.Stream<AgentRuntimeEvent, HarnessError>;
  readonly name: HarnessName;
  /**
   * Delivers a caller's answer to a blocking interaction request raised by a
   * connected session. Absent when the harness has no live session route, in
   * which case a blocking request fails the turn instead of waiting.
   */
  readonly respond?: (
    response: AgentInteractionResponse
  ) => Effect.Effect<void, HarnessError>;
  readonly telemetryId?: AgentHarnessTelemetryId | undefined;
  readonly parseSessionId: (
    line: string
  ) => Effect.Effect<Option.Option<SessionId>, HarnessError>;
}
