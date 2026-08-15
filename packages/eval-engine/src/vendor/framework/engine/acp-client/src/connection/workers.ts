import { Effect, Stream } from "effect";

import type { Terminate } from "./internal.ts";
import type { AcpConnectionError } from "../errors.ts";
import type { AcpTransportShape } from "../transport.ts";

import { transportError } from "./protocol.ts";
import {
  AcpConnectionClosedError,
  AcpPeerExitedError,
} from "../errors.ts";

export const makeReader = (
  transport: AcpTransportShape,
  handleInbound: (message: unknown) => Effect.Effect<void, AcpConnectionError>,
  terminate: Terminate
): Effect.Effect<void> =>
  transport.incoming.pipe(
    Stream.mapError((cause) => transportError("read", cause)),
    Stream.runForEach(handleInbound),
    Effect.matchEffect({
      onFailure: terminate,
      onSuccess: () =>
        terminate(
          new AcpConnectionClosedError({ reason: "input stream ended" })
        ),
    })
  );

export const makePeerWatcher = (
  transport: AcpTransportShape,
  terminate: Terminate
): Effect.Effect<void> =>
  transport.exit.pipe(
    Effect.matchEffect({
      onFailure: (cause) => terminate(transportError("wait-for-exit", cause)),
      onSuccess: (exit) => terminate(new AcpPeerExitedError(exit)),
    })
  );
