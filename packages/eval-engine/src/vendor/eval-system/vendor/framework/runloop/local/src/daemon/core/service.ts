import type { Effect, Stream } from "effect";

import { Context } from "effect";

import type {
  RuntimeJournalError,
  RuntimeValidationError,
} from "../../../../../contracts/internal/src/errors.ts";
import type { RuntimeCommand } from "../../../../../contracts/internal/src/runtime/command-types.ts";
import type { RuntimeStreamEvent } from "../../../../../contracts/internal/src/runtime/stream-event-types.ts";

export interface RouteKitEvalDaemonShape {
  readonly cancel: (commandId: string) => Effect.Effect<void>;
  readonly invoke: (
    command: RuntimeCommand
  ) => Stream.Stream<
    RuntimeStreamEvent,
    RuntimeJournalError | RuntimeValidationError
  >;
}

export class RouteKitEvalDaemon extends Context.Service<RouteKitEvalDaemon, RouteKitEvalDaemonShape>()(
  "routekit-eval/runtime/RouteKitEvalDaemon"
) {}
