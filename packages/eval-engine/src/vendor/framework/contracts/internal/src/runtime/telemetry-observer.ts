import { Context, Effect, Layer } from "effect";

export const TELEMETRY_EVENT_NAMES = [
  "cli_command",
  "session_start",
  "session_end",
  "agent_run",
  "schedule_run",
  "feature_invoked",
  "slash_command",
  "run_steered",
  "thread_forked",
  "install_first_run",
  "update_check",
  "cli_error",
  "eval_run",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

/**
 * A telemetry prop value. The contract accepts unbounded primitives (any
 * `string`, any `number`) on purpose; RFC 0012 bounds (string length ≤ 128,
 * integers only) are enforced downstream by each adapter, not by this type.
 * The CLI adapter applies them via `clampProps` in `Telemetry.emit`, so a
 * non-CLI adapter must clamp its own props.
 */
export type TelemetryObserverPropValue = string | number | boolean;

export type TelemetryObserverProps = Readonly<
  Record<string, TelemetryObserverPropValue>
>;

export interface TelemetryObserverShape {
  readonly observe: (
    event: TelemetryEventName,
    props?: TelemetryObserverProps
  ) => Effect.Effect<void>;
}

const noopShape: TelemetryObserverShape = {
  observe: () => Effect.void,
};

export class TelemetryObserver extends Context.Service<
  TelemetryObserver,
  TelemetryObserverShape
>()("ori/runtime/TelemetryObserver") {
  static readonly noop = noopShape;
  static readonly layer = Layer.succeed(TelemetryObserver)(
    TelemetryObserver.of(noopShape)
  );
}
