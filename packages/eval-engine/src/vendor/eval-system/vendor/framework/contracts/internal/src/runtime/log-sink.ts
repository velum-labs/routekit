import { Context, Effect, Layer } from "effect";

import type { LogSinkShape } from "./services.ts";

/**
 * The terminal destination for diagnostic {@link LogSinkShape | log records}.
 * This is a pure port — runtimes provide a concrete sink adapter (CLI stderr via
 * `CliLogSinkLive` in `@routekit-eval-engine/runtime-io`, or the daemon log hub);
 * {@link LogSink.layerTest} provides an inert stand-in for tests.
 */
export class LogSink extends Context.Service<LogSink, LogSinkShape>()(
  "routekit-eval/runtime/LogSink"
) {
  /**
   * Test seam: a `LogSink` that drops every record. Override `write` for a case
   * that needs to observe emitted records (e.g. a capturing sink).
   */
  static readonly layerTest = (
    impl: Partial<LogSinkShape>
  ): Layer.Layer<LogSink> =>
    Layer.succeed(LogSink)(
      LogSink.of({
        write: () => Effect.void,
        ...impl,
      })
    );
}
