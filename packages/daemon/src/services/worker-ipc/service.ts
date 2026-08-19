import { Context, Deferred, Effect, Layer, Queue } from "effect";

import type { HostWorkerMessage, WorkerRequest } from "../../host-protocol.js";

export type WorkerIpcEvent =
  | { readonly type: "request"; readonly request: WorkerRequest }
  | { readonly type: "disconnect" };

export type WorkerIpcValue = {
  readonly events: Queue.Queue<WorkerIpcEvent>;
  readonly finished: Deferred.Deferred<void, Error>;
};

/** Effect-owned worker IPC listener lifetime. */
export class WorkerIpc extends Context.Service<WorkerIpc, WorkerIpcValue>()(
  "@velum-labs/routekit-daemon/WorkerIpc"
) {
  static layer(
    acceptHostResponse: (
      response: Extract<HostWorkerMessage, { type: "host.response" }>
    ) => void
  ): Layer.Layer<WorkerIpc> {
    return Layer.effect(
      WorkerIpc,
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<WorkerIpcEvent>();
        const finished = yield* Deferred.make<void, Error>();
        const onMessage = (message: unknown): void => {
          const hostMessage = message as HostWorkerMessage;
          if (hostMessage.type === "host.response") {
            acceptHostResponse(hostMessage);
            return;
          }
          if (!hostMessage.type.startsWith("worker.")) return;
          Queue.offerUnsafe(events, {
            type: "request",
            request: hostMessage as WorkerRequest
          });
        };
        const onDisconnect = (): void => {
          Queue.offerUnsafe(events, { type: "disconnect" });
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.on("message", onMessage);
            process.once("disconnect", onDisconnect);
          }),
          () =>
            Effect.sync(() => {
              process.off("message", onMessage);
              process.off("disconnect", onDisconnect);
            }).pipe(Effect.andThen(Queue.shutdown(events)))
        );
        return { events, finished };
      })
    );
  }
}
