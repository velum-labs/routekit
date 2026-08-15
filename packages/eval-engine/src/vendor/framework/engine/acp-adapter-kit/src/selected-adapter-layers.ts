import { Layer } from "effect";

import type { AcpClientRequestHandlerShape } from "../../acp-agent/src/service.ts";
import type { AcpTransportShape } from "../../acp-client/src/transport.ts";

import { AcpClientRequestHandler } from "../../acp-agent/src/service.ts";
import { AcpTransport } from "../../acp-client/src/transport.ts";

/**
 * The two `Layer.succeed` provisions a subprocess ACP adapter feeds into
 * `AcpAgentConnectionLive`, named so the composition root reads as a graph of
 * adapters rather than inline layer literals. Both tags are OWNED elsewhere —
 * `AcpClientRequestHandler` by `@ori-engine/acp-agent` and `AcpTransport` by
 * `@ori-engine/acp-client` — and imported as-is; these factories only bind an
 * already-built value to its tag.
 *
 * Only `cancelSession`/`handle` cross the `AcpClientRequestHandler` tag. The
 * bridge's out-of-band `bind`/`run` wiring (the `Deferred` that hands the live
 * connection back to the handler, and the forked event pump) stays in each
 * adapter's `selected-adapter.ts`, off the tag, because the connection does not
 * exist yet when this layer is provided.
 */
export const acpClientRequestHandlerLive = (
  bridge: Pick<AcpClientRequestHandlerShape, "cancelSession" | "handle">
): Layer.Layer<AcpClientRequestHandler> =>
  Layer.succeed(AcpClientRequestHandler)(
    AcpClientRequestHandler.of({
      cancelSession: bridge.cancelSession,
      handle: bridge.handle,
    })
  );

/**
 * Binds the agent side of the in-memory transport pair to the `AcpTransport`
 * tag. The client side is returned to the caller of the adapter's selected-peer
 * factory (it drives the peer), and the pair's shared lifecycle (`close`) is
 * managed by that adapter's `selected-adapter.ts`.
 */
export const acpTransportLive = (
  transport: AcpTransportShape
): Layer.Layer<AcpTransport> =>
  Layer.succeed(AcpTransport)(AcpTransport.of(transport));
