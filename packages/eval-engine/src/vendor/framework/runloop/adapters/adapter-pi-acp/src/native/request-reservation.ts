import type { Deferred, Effect } from "effect";

import { Option, Ref, Result } from "effect";

import type {
  ConnectionState,
  PiNativeConnectionError,
  PiRequestInput,
} from "./connection-types.ts";
import type { PiResponse } from "./schema.ts";

export const reserveRequest = (
  state: Ref.Ref<ConnectionState>,
  command: PiRequestInput,
  deferred: Deferred.Deferred<PiResponse, PiNativeConnectionError>
): Effect.Effect<Result.Result<string, PiNativeConnectionError>> =>
  Ref.modify(
    state,
    (
      current
    ): readonly [
      Result.Result<string, PiNativeConnectionError>,
      ConnectionState,
    ] => {
      if (Option.isSome(current.closed)) {
        return [Result.fail(current.closed.value), current] as const;
      }
      const id = `pi-${current.nextId}`;
      return [
        Result.succeed(id),
        {
          ...current,
          nextId: current.nextId + 1,
          pending: new Map(current.pending).set(id, {
            command: command.type,
            deferred,
          }),
        },
      ] as const;
    }
  );
