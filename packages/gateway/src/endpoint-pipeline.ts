/**
 * The fixed gateway endpoint pipeline. Endpoint modules supply concrete stage
 * functions; this coordinator makes the boundary ordering explicit and
 * prevents transport handlers from interleaving authentication, decoding,
 * routing, execution, observation, and encoding.
 */
import { Effect } from "effect";

export type EndpointPipeline<I, D, R, X, O, E = never, Requirements = never> = Readonly<{
  authenticate(input: I): Effect.Effect<void, E, Requirements>;
  decode(input: I): Effect.Effect<D, E, Requirements>;
  resolve(decoded: D): Effect.Effect<R, E, Requirements>;
  execute(route: R): Effect.Effect<X, E, Requirements>;
  observe(result: X): Effect.Effect<O, E, Requirements>;
  encode(observed: O): Effect.Effect<void, E, Requirements>;
}>;

export function runEndpointPipeline<I, D, R, X, O, E, Requirements>(
  input: I,
  pipeline: EndpointPipeline<I, D, R, X, O, E, Requirements>
) {
  return Effect.gen(function* () {
    yield* pipeline.authenticate(input);
    const decoded = yield* pipeline.decode(input);
    const route = yield* pipeline.resolve(decoded);
    const result = yield* pipeline.execute(route);
    const observed = yield* pipeline.observe(result);
    yield* pipeline.encode(observed);
  });
}
