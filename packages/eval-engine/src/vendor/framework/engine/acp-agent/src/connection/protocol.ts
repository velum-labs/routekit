/* oxlint-disable typescript/explicit-function-return-type -- preserve Effect inference */
import { Effect, Ref } from "effect";

import type { ConnectionState } from "./internal.ts";

import {
  AcpAgentInitializationError,
  AcpAgentProtocolError,
} from "../errors.ts";

export const INTERNAL_ERROR = -32_000;
export const METHOD_NOT_FOUND = -32_601;
export const REQUEST_CANCELLED = -32_800;
// The runloop uses this distinct code to identify a dead selected-adapter peer
// and invalidate its cached resource without discarding ordinary turn errors.
export const PEER_EXIT_ERROR_CODE = -32_004;

export const protocolFailure = (reason = "invalid ACP message") =>
  new AcpAgentProtocolError({ reason });

export const requireInitialized = (state: Ref.Ref<ConnectionState>) =>
  Ref.get(state).pipe(
    Effect.flatMap((current) => {
      if (current.closed !== undefined) {
        return Effect.fail(current.closed);
      }
      return current.capabilities === undefined
        ? new AcpAgentInitializationError({ reason: "NotInitialized" })
        : Effect.succeed(current.capabilities);
    })
  );
