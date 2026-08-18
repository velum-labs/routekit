import { Effect } from "effect";

import type { AcpConnectionError } from "../../acp-client/src/errors.ts";
import type {
  AcpConnectionShape,
  AcpInitializeParams,
} from "../../acp-client/src/service.ts";

const awaitConnectionReady = (
  connection: AcpConnectionShape
): Effect.Effect<void, AcpConnectionError> =>
  connection.capabilities.pipe(
    Effect.catchTag("AcpInitializationError", (error) =>
      error.reason === "NotInitialized"
        ? Effect.sleep("10 millis").pipe(
            Effect.andThen(
              Effect.suspend(() => awaitConnectionReady(connection))
            )
          )
        : Effect.fail(error)
    ),
    Effect.asVoid
  );

const initializeConnectionOnce = (
  connection: AcpConnectionShape,
  clientCapabilities: NonNullable<AcpInitializeParams["clientCapabilities"]>
): Effect.Effect<void, AcpConnectionError> =>
  connection.initialize({ clientCapabilities }).pipe(
    Effect.catchTag("AcpInitializationError", (error) => {
      if (error.reason === "AlreadyInitialized") {
        return Effect.void;
      }
      return error.reason === "InitializationInProgress"
        ? awaitConnectionReady(connection)
        : Effect.fail(error);
    }),
    Effect.asVoid
  );

export { initializeConnectionOnce };
