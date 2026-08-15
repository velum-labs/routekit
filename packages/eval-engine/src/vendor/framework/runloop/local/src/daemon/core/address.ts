import { Context, Effect, Layer, Option, Ref } from "effect";

export interface DaemonAddressShape {
  /** The daemon's connectable base URL (e.g. `http://127.0.0.1:59744`), once serving. */
  readonly get: Effect.Effect<Option.Option<string>>;
  readonly set: (baseUrl: string) => Effect.Effect<void>;
}

/**
 * The daemon's own HTTP base URL, set by the server after it binds
 * (the port may be ephemeral, so it is unknowable at layer-construction time)
 * and read wherever the daemon needs to hand out self-referential URLs — the
 * rollover seed prompt points the re-seeded session at its predecessor's
 * `/api/events` and `/api/sessions/:id/lineage` endpoints.
 */
export class DaemonAddress extends Context.Service<
  DaemonAddress,
  DaemonAddressShape
>()("ori/runtime/DaemonAddress") {
  static readonly layer: Layer.Layer<DaemonAddress> = Layer.effect(
    DaemonAddress
  )(
    Effect.gen(function* () {
      const ref = yield* Ref.make(Option.none<string>());
      return DaemonAddress.of({
        get: Ref.get(ref),
        set: (baseUrl) => Ref.set(ref, Option.some(baseUrl)),
      });
    })
  );
}
