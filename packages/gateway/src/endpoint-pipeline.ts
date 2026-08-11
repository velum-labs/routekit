/**
 * The fixed gateway endpoint pipeline. Endpoint modules supply concrete stage
 * functions; this coordinator makes the boundary ordering explicit and
 * prevents transport handlers from interleaving authentication, decoding,
 * routing, execution, observation, and encoding.
 */
export type EndpointPipeline<I, D, R, X, O> = Readonly<{
  authenticate(input: I): void | Promise<void>;
  decode(input: I): D | Promise<D>;
  resolve(decoded: D): R | Promise<R>;
  execute(route: R): X | Promise<X>;
  observe(result: X): O | Promise<O>;
  encode(observed: O): void | Promise<void>;
}>;

export async function runEndpointPipeline<I, D, R, X, O>(
  input: I,
  pipeline: EndpointPipeline<I, D, R, X, O>
): Promise<void> {
  await pipeline.authenticate(input);
  const decoded = await pipeline.decode(input);
  const route = await pipeline.resolve(decoded);
  const result = await pipeline.execute(route);
  const observed = await pipeline.observe(result);
  await pipeline.encode(observed);
}
