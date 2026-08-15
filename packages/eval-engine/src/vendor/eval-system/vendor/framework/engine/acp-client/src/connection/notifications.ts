import {
  Deferred,
  Effect,
  Filter,
  Option,
  Queue,
  Ref,
  Schedule,
  Stream,
} from "effect";

import type {
  ConnectionResources,
  NotificationConsumerLease,
} from "./internal.ts";
import type { AcpAgentKnownNotification } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpConnectionError } from "../errors.ts";

import { AcpNotificationConsumerActiveError } from "../errors.ts";

/**
 * Take the single notification-consumer lease for the lifetime of `stream`.
 *
 * Acquisition clears whatever is still queued: those items belong to an
 * operation that has already settled, and ACP notifications carry no request id
 * to correlate them with, so delivering them to the next consumer would report
 * one operation's updates as another's. Release resolves `ended`, which frees
 * the reader from a publish that is waiting on notification capacity.
 */
const withNotificationConsumerLease = <A>(
  resources: ConnectionResources,
  stream: Stream.Stream<A, AcpConnectionError>
): Stream.Stream<A, AcpConnectionError> =>
  Stream.unwrap(
    Effect.acquireRelease(
      Deferred.make<true>().pipe(
        Effect.flatMap((ended) =>
          Ref.modify(resources.notificationConsumer, (current) =>
            Option.isSome(current)
              ? [Option.none<NotificationConsumerLease>(), current]
              : [Option.some({ ended }), Option.some({ ended })]
          )
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => new AcpNotificationConsumerActiveError(),
            onSome: (lease: NotificationConsumerLease) =>
              Queue.clear(resources.notifications).pipe(Effect.as(lease)),
          })
        )
      ),
      (lease) =>
        Ref.set(resources.notificationConsumer, Option.none()).pipe(
          Effect.andThen(Deferred.succeed(lease.ended, true))
        )
    ).pipe(Effect.as(stream))
  );

export const makeNotifications = (
  resources: ConnectionResources
): Stream.Stream<AcpAgentKnownNotification, AcpConnectionError> =>
  withNotificationConsumerLease(
    resources,
    Stream.fromQueue(resources.notifications).pipe(
      Stream.filterMap(
        Filter.fromPredicateOption((item) =>
          item.type === "notification"
            ? Option.some(item.notification)
            : Option.none()
        )
      ),
      Stream.merge(
        Stream.fromEffect(
          Deferred.await(resources.closed).pipe(Effect.flatMap(Effect.fail))
        ),
        { haltStrategy: "either" }
      )
    )
  );

export const makeNotificationsUntil = (
  resources: ConnectionResources,
  signal: Effect.Effect<unknown, AcpConnectionError>
): Stream.Stream<AcpAgentKnownNotification, AcpConnectionError> =>
  withNotificationConsumerLease(
    resources,
    Stream.unwrap(
      Effect.gen(function* () {
        const token = {};
        const completion = yield* Deferred.make<unknown, AcpConnectionError>();
        const notifications = Stream.fromEffect(
          Queue.take(resources.notifications)
        ).pipe(
          Stream.repeat(Schedule.forever),
          Stream.takeUntil(
            (item) => item.type === "barrier" && item.token === token
          ),
          Stream.filterMap(
            Filter.fromPredicateOption((item) =>
              item.type === "notification"
                ? Option.some(item.notification)
                : Option.none()
            )
          )
        );
        const boundary = Stream.fromEffect(
          Effect.exit(signal).pipe(
            Effect.flatMap((exit) =>
              Deferred.done(completion, exit).pipe(
                Effect.andThen(
                  Queue.offer(resources.notifications, {
                    token,
                    type: "barrier",
                  })
                )
              )
            )
          )
        ).pipe(Stream.drain);
        return notifications.pipe(
          Stream.merge(boundary, { haltStrategy: "both" }),
          Stream.concat(
            Stream.fromEffect(Deferred.await(completion)).pipe(Stream.drain)
          )
        );
      })
    )
  );
