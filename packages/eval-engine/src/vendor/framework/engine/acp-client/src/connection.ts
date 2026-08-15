import {
  Cause,
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
  ConnectionNotificationItem,
  ConnectionResources,
  ConnectionState,
  Enqueue,
  InboundWork,
  InitializationState,
  NotificationConsumerLease,
  OutboundItem,
  Terminate,
} from "./connection/internal.ts";
import type { AcpRawRequest } from "./connection/request-state.ts";
import type {
  AcpConnectionConfigError,
  AcpConnectionError,
} from "./errors.ts";
import type {
  AcpConnectionOptions,
  AcpConnectionShape,
} from "./service.ts";

import { handleKnownRequest, makeInboundHandler } from "./connection/inbound.ts";
import {
  makeInitialize,
  makeOperationalNotify,
  makeOperationalRequest,
  requireCapabilities,
} from "./connection/initialization.ts";
import {
  makeNotifications,
  makeNotificationsUntil,
} from "./connection/notifications.ts";
import {
  makeCancellationOffer,
  makeEnqueue,
  makeWriter,
} from "./connection/outbound.ts";
import { makeCompleteResponse, makeRequest } from "./connection/request-state.ts";
import { makeTerminate } from "./connection/terminate.ts";
import { makePeerWatcher, makeReader } from "./connection/workers.ts";
import {
  AcpConnectionClosedError,
  AcpConnectionConfigError as AcpConnectionConfigFailure,
  AcpProtocolError,
} from "./errors.ts";
import {
  AcpAgentRequestHandler,
  AcpConnection,
} from "./service.ts";
import { AcpTransport } from "./transport.ts";

const DEFAULT_OUTBOUND_CAPACITY = 16;
const DEFAULT_PENDING_REQUEST_CAPACITY = 64;
const DEFAULT_INBOUND_REQUEST_CAPACITY = 32;
const DEFAULT_INBOUND_CONCURRENCY = 4;
const DEFAULT_NOTIFICATION_CAPACITY = 64;
const DEFAULT_CANCELLATION_RETENTION = 64;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const ConnectionOptionsSchema = Schema.Struct({
  cancellationRetention: Schema.optionalKey(PositiveInt),
  inboundConcurrency: Schema.optionalKey(PositiveInt),
  inboundRequestCapacity: Schema.optionalKey(PositiveInt),
  notificationCapacity: Schema.optionalKey(PositiveInt),
  outboundCapacity: Schema.optionalKey(PositiveInt),
  pendingRequestCapacity: Schema.optionalKey(PositiveInt),
});

// Structurally extract the offending option name from the schema error rather
// than flattening every failure to one opaque reason, so a bad bound names the
// field that was invalid (e.g. "outboundCapacity must be a positive integer").
const ConfigIssueSummary = Schema.Struct({
  issue: Schema.Struct({
    issues: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.String) })),
  }),
});
const decodeConfigIssueSummary = Schema.decodeUnknownOption(ConfigIssueSummary);

const configFailure = (cause: unknown): AcpConnectionConfigError => {
  const field = Option.match(decodeConfigIssueSummary(cause), {
    onNone: (): string | undefined => undefined,
    onSome: ({ issue }) => issue.issues[0]?.path[0],
  });
  return new AcpConnectionConfigFailure({
    reason:
      field === undefined
        ? "invalid positive limit"
        : `${field} must be a positive integer`,
  });
};

const decodeConfig = (
  options: AcpConnectionOptions
): Effect.Effect<ConnectionConfig, AcpConnectionConfigError> =>
  Schema.decodeUnknownEffect(ConnectionOptionsSchema)(options).pipe(
    Effect.map(
      (decoded): ConnectionConfig => ({
        cancellationRetention:
          decoded.cancellationRetention ?? DEFAULT_CANCELLATION_RETENTION,
        inboundConcurrency:
          decoded.inboundConcurrency ?? DEFAULT_INBOUND_CONCURRENCY,
        inboundRequestCapacity:
          decoded.inboundRequestCapacity ?? DEFAULT_INBOUND_REQUEST_CAPACITY,
        notificationCapacity:
          decoded.notificationCapacity ?? DEFAULT_NOTIFICATION_CAPACITY,
        outboundCapacity: decoded.outboundCapacity ?? DEFAULT_OUTBOUND_CAPACITY,
        pendingRequestCapacity:
          decoded.pendingRequestCapacity ?? DEFAULT_PENDING_REQUEST_CAPACITY,
      })
    ),
    Effect.mapError(configFailure)
  );

const makeResources = Effect.fn("AcpConnection.makeResources")(function* (
  config: ConnectionConfig
) {
  const transport = yield* AcpTransport;
  const state = yield* Ref.make<ConnectionState>({
    activeInbound: new Map(),
    cancelled: new Set(),
    closed: undefined,
    nextId: 1,
    outboundAcknowledgements: new Set(),
    pending: new Map(),
  });
  return {
    closed: yield* Deferred.make<AcpConnectionError>(),
    inboundRequests: yield* Queue.bounded<InboundWork>(
      config.inboundRequestCapacity
    ),
    initialization: yield* Ref.make<InitializationState>({ type: "fresh" }),
    notificationConsumer: yield* Ref.make(
      Option.none<NotificationConsumerLease>()
    ),
    notifications: yield* Queue.bounded<ConnectionNotificationItem>(
      config.notificationCapacity
    ),
    outbound: yield* Queue.bounded<OutboundItem>(config.outboundCapacity),
    state,
    stop: yield* Deferred.make<true>(),
    transport,
  } satisfies ConnectionResources;
});

const makeConnectionService = ({
  enqueue,
  request,
  resources,
  shutdown,
  terminate,
}: {
  readonly enqueue: Enqueue;
  readonly request: AcpRawRequest;
  readonly resources: ConnectionResources;
  readonly shutdown: Effect.Effect<void>;
  readonly terminate: Terminate;
}): AcpConnectionShape => {
  const operationalRequest = makeOperationalRequest(
    resources.initialization,
    request
  );
  return AcpConnection.of({
    capabilities: requireCapabilities(resources.initialization),
    initialize: makeInitialize({
      request,
      state: resources.initialization,
      terminate,
    }),
    notifications: makeNotifications(resources),
    notify: makeOperationalNotify(resources.initialization, enqueue),
    request: operationalRequest,
    requestNotifications: (method, params) =>
      makeNotificationsUntil(resources, operationalRequest(method, params)),
    shutdown,
  });
};

const makeRequestComponents = (
  resources: ConnectionResources,
  config: ConnectionConfig,
  terminate: Terminate
): {
  readonly enqueue: Enqueue;
  readonly request: AcpRawRequest;
} => {
  const enqueue = makeEnqueue(resources.outbound, resources.state);
  return {
    enqueue,
    request: makeRequest({
      config,
      enqueue,
      offerCancellation: makeCancellationOffer(
        resources.outbound,
        config.outboundCapacity
      ),
      state: resources.state,
      terminate,
    }),
  };
};

const makeWorkerRecovery =
  (terminate: Terminate) =>
  (worker: Effect.Effect<void>): Effect.Effect<void> =>
    worker.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : terminate(new AcpProtocolError({ reason: "InboundWorkerFailure" }))
      )
    );

const makeConnection = Effect.fn("AcpConnection.makeConnection")(function* (
  config: ConnectionConfig
) {
  const handler = yield* AcpAgentRequestHandler;
  const resources = yield* makeResources(config);
  const { state, transport } = resources;
  const terminate = makeTerminate(resources);
  const { enqueue, request } = makeRequestComponents(
    resources,
    config,
    terminate
  );
  const completeResponse = makeCompleteResponse({
    state,
    terminate,
  });
  const runWorker = (worker: Effect.Effect<void>): Effect.Effect<void> =>
    Effect.raceFirst(worker, Deferred.await(resources.stop));
  const fibers = [
    yield* makeWriter(resources.outbound, transport, terminate).pipe(
      runWorker,
      Effect.forkScoped
    ),
    yield* makeReader(
      transport,
      makeInboundHandler({
        completeResponse,
        enqueue,
        resources,
      }),
      terminate
    ).pipe(runWorker, Effect.forkScoped),
    yield* makePeerWatcher(transport, terminate).pipe(
      runWorker,
      Effect.forkScoped
    ),
  ];
  for (let index = 0; index < config.inboundConcurrency; index += 1) {
    fibers.push(
      yield* Stream.fromQueue(resources.inboundRequests).pipe(
        Stream.runForEach((work) =>
          handleKnownRequest({
            enqueue,
            handler,
            state,
            work,
          })
        ),
        Effect.catch(terminate),
        makeWorkerRecovery(terminate),
        runWorker,
        Effect.forkScoped
      )
    );
  }
  const shutdown = terminate(
    new AcpConnectionClosedError({ reason: "shutdown" })
  ).pipe(Effect.andThen(Fiber.awaitAll(fibers)), Effect.asVoid);
  return makeConnectionService({
    enqueue,
    request,
    resources,
    shutdown,
    terminate,
  });
});

/**
 * The live {@link AcpConnection} adapter: acquires the JSON-RPC connection over
 * an {@link AcpTransport}, wires the {@link AcpAgentRequestHandler}, and runs
 * the reader/writer/peer-watcher fibers for the scope's lifetime. It is a
 * scoped resource — `Effect.acquireRelease` shuts the connection down on scope
 * close — so consumers provide it and discharge the `Scope` (see
 * `provideConnection` in `connection/test-support.ts`).
 *
 * `AcpAgentRequestHandler` and `AcpTransport` stay in the requirement channel
 * (not self-provided), so each embedding site supplies the real subprocess
 * transport and handler; the only produced service is `AcpConnection`. This is
 * a factory rather than a bare `const` layer because `options` is a runtime
 * binding (per-connection capacity/concurrency tuning), not a `Config` value.
 * Invalid bounds surface as `AcpConnectionConfigError` before acquisition.
 */
export const AcpConnectionLive = (
  options: AcpConnectionOptions = {}
): Layer.Layer<
  AcpConnection,
  AcpConnectionConfigError,
  AcpAgentRequestHandler | AcpTransport
> =>
  Layer.effect(AcpConnection)(
    Effect.gen(function* () {
      const config = yield* decodeConfig(options);
      return yield* Effect.acquireRelease(
        makeConnection(config),
        (connection) => connection.shutdown
      );
    })
  );

export { AcpConnection } from "./service.ts";
