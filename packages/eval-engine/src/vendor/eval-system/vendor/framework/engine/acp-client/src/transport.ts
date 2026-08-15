import type { Schema } from "effect";

import { Context, Data, Effect, Layer, Stream } from "effect";

export interface AcpPeerExit {
  readonly code?: number;
  readonly signal?: string;
}

/**
 * The raw failure a transport implementation raises on its own operations,
 * before a connection consumer maps it into an `AcpTransportError`. It gives
 * the transport contract's `close`, `exit`, `incoming`, and `send` channels a
 * concrete owned error instead of `unknown`, so producers stay assignable
 * without widening the shape. Only a bounded, sanitized `detail` crosses the
 * boundary; no raw cause is carried.
 */
export class AcpTransportFault extends Data.TaggedError("AcpTransportFault")<{
  readonly operation: "close" | "exit" | "incoming" | "send";
  readonly detail?: string;
}> {}

/**
 * Byte transports must decode one value per element through the pinned bounded
 * ACP framer. The connection deliberately starts after that byte boundary.
 */
export interface AcpTransportShape {
  readonly close: Effect.Effect<void, AcpTransportFault>;
  readonly exit: Effect.Effect<AcpPeerExit, AcpTransportFault>;
  readonly incoming: Stream.Stream<unknown, AcpTransportFault>;
  // `send` targets a byte pipe whose native write can fail with any host error.
  // Each transport implementation maps that raw failure into an AcpTransportFault
  // carrying a bounded `detail`; the connection then re-bounds it into an
  // AcpTransportError at its own boundary (see connection/protocol.ts +
  // transport-cause.test.ts).
  readonly send: (
    message: Schema.Json
  ) => Effect.Effect<void, AcpTransportFault>;
}

export class AcpTransport extends Context.Service<
  AcpTransport,
  AcpTransportShape
>()("routekit-eval/acp-client/AcpTransport") {
  /**
   * Test seam: an inert transport — no bytes ever arrive (`incoming` is the
   * empty stream), every `send` is swallowed as void, `close` is void, and
   * `exit` reports a clean `{}` with no code or signal. It carries no peer, so
   * it never drives a connection on its own; a case that needs traffic
   * overrides the field it cares about. The real transports are the
   * subprocess/byte adapters in the ACP adapter packages (`adapter-claude-acp`,
   * `adapter-pi-acp`), which is why this port ships no `AcpTransportLive`.
   */
  static readonly layerTest = (
    impl: Partial<AcpTransportShape>
  ): Layer.Layer<AcpTransport> =>
    Layer.succeed(AcpTransport)(
      AcpTransport.of({
        close: Effect.void,
        exit: Effect.succeed({}),
        incoming: Stream.empty,
        send: () => Effect.void,
        ...impl,
      })
    );
}
