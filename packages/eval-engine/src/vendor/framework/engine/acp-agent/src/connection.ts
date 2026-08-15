/* oxlint-disable typescript/explicit-function-return-type -- preserve Effect inference */
/* oxlint-disable typescript/no-unsafe-type-assertion -- codec overloads lose method correlation */
/* oxlint-disable eslint/max-lines-per-function -- connection assembly is one scoped resource graph */
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";

import type {
  ConnectionConfig,
  ConnectionResources,
  ConnectionState,
  InboundWork,
  OutboundItem,
  PendingRequest,
} from "./connection/internal.ts";
import type { AcpDecodedAgentPeerMessage } from "../../../contracts/internal/src/acp/codec/codec.ts";
import type { AssertAssignable } from "../../../contracts/internal/src/type-boundary.ts";
import type { AcpAgentConnectionError } from "./errors.ts";
import type {
  AcpAgentConnectionOptions,
  AcpAgentConnectionShape,
  AcpAgentNotificationMethod,
  AcpAgentNotificationParams,
} from "./service.ts";

import { handleRequest, makeInboundHandler } from "./connection/inbound.ts";
import { makeEnqueue, makeWriter } from "./connection/outbound.ts";
import { protocolFailure, requireInitialized } from "./connection/protocol.ts";
import { makeCompleteResponse, makeRequest } from "./connection/request-state.ts";
import { encodeAcpPeerMessage } from "../../../contracts/internal/src/acp/codec/codec.ts";
import {
  AcpAgentConfigError,
  AcpAgentConnectionClosedError,
  AcpAgentPeerExitedError,
  AcpAgentTransportError,
} from "./errors.ts";
import {
  AcpAgentConnection,
  AcpClientRequestHandler,
} from "./service.ts";
import { AcpTransport } from "../../acp-client/src/transport.ts";

const DEFAULT_CONFIG: ConnectionConfig = {
  cancellationRetention: 64,
  inboundConcurrency: 4,
  inboundRequestCapacity: 32,
  outboundCapacity: 16,
  pendingRequestCapacity: 64,
};
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const OptionsSchema = Schema.Struct({
  cancellationRetention: Schema.optionalKey(PositiveInt),
  inboundConcurrency: Schema.optionalKey(PositiveInt),
  inboundRequestCapacity: Schema.optionalKey(PositiveInt),
  outboundCapacity: Schema.optionalKey(PositiveInt),
  pendingRequestCapacity: Schema.optionalKey(PositiveInt),
});

// Drift guard: the public `AcpAgentConnectionOptions` interface and the schema
// that validates it must stay structurally identical, so neither can gain or
// drop a field without the other (guide: no hand-maintained parallel type).
type _SchemaMatchesInterface = AssertAssignable<
  typeof OptionsSchema.Type,
  AcpAgentConnectionOptions
>;
type _InterfaceMatchesSchema = AssertAssignable<
  AcpAgentConnectionOptions,
  typeof OptionsSchema.Type
>;

const makeResources = Effect.fn("AcpAgentConnection.makeResources")(function* (
  config: ConnectionConfig
) {
  const transport = yield* AcpTransport;
  return {
    cancellationOutbound: yield* Queue.bounded<OutboundItem>(
      config.pendingRequestCapacity + config.outboundCapacity
    ),
    inboundRequests: yield* Queue.bounded<InboundWork>(
      config.inboundRequestCapacity
    ),
    outbound: yield* Queue.bounded<OutboundItem>(config.outboundCapacity),
    state: yield* Ref.make<ConnectionState>({
      active: new Map(),
      cancelled: new Set(),
      initializing: false,
      nextId: 1,
      outboundAcknowledgements: new Set(),
      pending: new Map(),
    }),
    stop: yield* Deferred.make<true>(),
    transport,
  } satisfies ConnectionResources;
});

const makeTerminate = (resources: ConnectionResources) =>
  Effect.fn("AcpAgentConnection.terminate")((error: AcpAgentConnectionError) =>
    Effect.uninterruptible(
      Ref.modify<
        ConnectionState,
        Option.Option<{
          readonly acknowledgements: readonly Deferred.Deferred<
            true,
            AcpAgentConnectionError
          >[];
          readonly active: readonly {
            readonly cancel: Deferred.Deferred<true>;
          }[];
          readonly pending: readonly PendingRequest[];
        }>
      >(resources.state, (current) => {
        if (current.closed !== undefined) {
          return [Option.none(), current] as const;
        }
        return [
          Option.some({
            acknowledgements: [...current.outboundAcknowledgements],
            active: [...current.active.values()],
            pending: [...current.pending.values()],
          }),
          {
            ...current,
            active: new Map(),
            closed: error,
            outboundAcknowledgements: new Set<
              Deferred.Deferred<true, AcpAgentConnectionError>
            >(),
            pending: new Map<number, PendingRequest>(),
          },
        ] as const;
      }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: ({ acknowledgements, active, pending }) =>
              Effect.all([
                ...pending.map(({ deferred }) =>
                  Deferred.fail(deferred, error)
                ),
                ...active.map(({ cancel }) => Deferred.succeed(cancel, true)),
                ...acknowledgements.map((item) => Deferred.fail(item, error)),
              ]).pipe(
                Effect.andThen(Queue.shutdown(resources.inboundRequests)),
                Effect.andThen(Queue.shutdown(resources.cancellationOutbound)),
                Effect.andThen(Queue.shutdown(resources.outbound)),
                Effect.andThen(Deferred.succeed(resources.stop, true)),
                Effect.andThen(
                  resources.transport.close.pipe(
                    Effect.timeout("1 second"),
                    Effect.ignore
                  )
                ),
                Effect.asVoid
              ),
          })
        )
      )
    )
  );

const makeConnection = Effect.fn("AcpAgentConnection.makeConnection")(
  function* (config: ConnectionConfig) {
    const handler = yield* AcpClientRequestHandler;
    const resources = yield* makeResources(config);
    const terminate = makeTerminate(resources);
    const enqueue = makeEnqueue(resources.outbound, resources.state);
    const completeResponse = makeCompleteResponse(resources.state, terminate);
    const inbound = makeInboundHandler(
      resources,
      handler,
      enqueue,
      completeResponse
    );
    const run = <E, R>(effect: Effect.Effect<void, E, R>) =>
      Effect.raceFirst(effect, Deferred.await(resources.stop)).pipe(
        Effect.ignore
      );
    const fibers = [
      yield* makeWriter(
        resources.outbound,
        resources.cancellationOutbound,
        resources.transport.send,
        terminate
      ).pipe(run, Effect.forkScoped),
      yield* resources.transport.incoming.pipe(
        Stream.mapError(
          () => new AcpAgentTransportError({ operation: "read" })
        ),
        Stream.runForEach(inbound),
        Effect.matchEffect({
          onFailure: terminate,
          onSuccess: () =>
            terminate(
              new AcpAgentConnectionClosedError({
                reason: "input stream ended",
              })
            ),
        }),
        run,
        Effect.forkScoped
      ),
      yield* resources.transport.exit.pipe(
        Effect.mapError(
          () => new AcpAgentTransportError({ operation: "wait-for-exit" })
        ),
        Effect.flatMap((exit) => terminate(new AcpAgentPeerExitedError(exit))),
        Effect.catch(terminate),
        run,
        Effect.forkScoped
      ),
    ];
    for (let index = 0; index < config.inboundConcurrency; index += 1) {
      fibers.push(
        yield* Stream.fromQueue(resources.inboundRequests).pipe(
          Stream.runForEach((work) =>
            handleRequest(resources, handler, enqueue, work)
          ),
          Effect.catch(terminate),
          run,
          Effect.forkScoped
        )
      );
    }
    const request = makeRequest(resources, config, enqueue);
    const notify = (<M extends AcpAgentNotificationMethod>(
      method: M,
      params: AcpAgentNotificationParams<M>
    ) =>
      requireInitialized(resources.state).pipe(
        Effect.andThen(
          encodeAcpPeerMessage("agent", {
            jsonrpc: "2.0",
            kind: "notification",
            method,
            params,
            supported: true,
          } as AcpDecodedAgentPeerMessage)
        ),
        Effect.mapError(() => protocolFailure()),
        Effect.flatMap(enqueue)
      )) as AcpAgentConnectionShape["notify"];
    const shutdown = terminate(
      new AcpAgentConnectionClosedError({ reason: "shutdown" })
    ).pipe(Effect.andThen(Fiber.awaitAll(fibers)), Effect.asVoid);
    return AcpAgentConnection.of({
      capabilities: requireInitialized(resources.state),
      notify,
      request,
      shutdown,
    });
  }
);

/**
 * The live {@link AcpAgentConnection} adapter: a scoped resource graph over an
 * `AcpTransport` pair and an `AcpClientRequestHandler`, driving the full
 * agent-side ACP protocol (initialize handshake, inbound request fan-out,
 * outbound request correlation, cancellation, and termination). Both
 * dependencies stay in the requirement channel, so the composition root
 * provides the transport and handler; the inert `AcpAgentConnection.layerTest`
 * seam is for cases that don't need a real connection.
 */
export const AcpAgentConnectionLive = (
  options: AcpAgentConnectionOptions = {}
): Layer.Layer<
  AcpAgentConnection,
  AcpAgentConfigError,
  AcpClientRequestHandler | AcpTransport
> =>
  Layer.effect(AcpAgentConnection)(
    Schema.decodeUnknownEffect(OptionsSchema)(options).pipe(
      Effect.mapError(
        () => new AcpAgentConfigError({ reason: "invalid positive limit" })
      ),
      Effect.map((decoded) => ({
        ...DEFAULT_CONFIG,
        ...decoded,
      })),
      Effect.flatMap((config) =>
        Effect.acquireRelease(
          makeConnection(config),
          (connection) => connection.shutdown
        )
      )
    )
  );

export { AcpAgentConnection } from "./service.ts";
