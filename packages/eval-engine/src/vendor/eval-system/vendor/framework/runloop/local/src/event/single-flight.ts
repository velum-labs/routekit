import { Deferred, Effect, Ref } from "effect";

interface SingleFlight<Key, Value, Failure> {
  readonly run: <R>(
    key: Key,
    effect: Effect.Effect<Value, Failure, R>
  ) => Effect.Effect<Value, Failure, R>;
}

interface SingleFlightReservation<Value, Failure> {
  readonly deferred: Deferred.Deferred<Value, Failure>;
  readonly owner: boolean;
}

const runSingleFlight = <Key, Value, Failure, Requirements>(input: {
  readonly effect: Effect.Effect<Value, Failure, Requirements>;
  readonly flights: Ref.Ref<Map<Key, Deferred.Deferred<Value, Failure>>>;
  readonly key: Key;
}): Effect.Effect<Value, Failure, Requirements> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<Value, Failure>();
      const reservation: SingleFlightReservation<Value, Failure> =
        yield* Ref.modify(input.flights, (flights) => {
          const existing = flights.get(input.key);
          if (existing !== undefined) {
            const existingReservation: SingleFlightReservation<Value, Failure> =
              {
                deferred: existing,
                owner: false,
              };
            return [existingReservation, flights] as const;
          }

          const newReservation: SingleFlightReservation<Value, Failure> = {
            deferred,
            owner: true,
          };
          return [
            newReservation,
            new Map([...flights, [input.key, deferred]]),
          ] as const;
        });

      if (!reservation.owner) {
        return yield* restore(Deferred.await(reservation.deferred));
      }

      const exit = yield* Effect.exit(restore(input.effect));
      yield* Deferred.done(deferred, exit);
      yield* Ref.update(input.flights, (flights) => {
        if (flights.get(input.key) !== deferred) {
          return flights;
        }

        const next = new Map(flights);
        next.delete(input.key);
        return next;
      });

      return yield* Deferred.await(deferred);
    })
  );

export const makeSingleFlight = <Key, Value, Failure>(): Effect.Effect<
  SingleFlight<Key, Value, Failure>
> =>
  Ref.make(new Map<Key, Deferred.Deferred<Value, Failure>>()).pipe(
    Effect.map((flights) => ({
      run: <R>(
        key: Key,
        effect: Effect.Effect<Value, Failure, R>
      ): Effect.Effect<Value, Failure, R> =>
        runSingleFlight({
          effect,
          flights,
          key,
        }),
    }))
  );

export type { SingleFlight };
