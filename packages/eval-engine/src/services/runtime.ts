import { Context, Effect, Layer, Stream } from "effect";
import { EvalEngine, type EvalEngineService, makeEvalEngineLayer } from "../engine.js";
import type {
  EvalEngineError,
  EvalEngineEvent,
  EvalEngineOptions,
  EvalExecutionOptions
} from "../model.js";

export interface EvalRuntimeService {
  readonly dryRun: (
    options: EvalExecutionOptions
  ) => Stream.Stream<EvalEngineEvent, EvalEngineError>;
  readonly run: (options: EvalExecutionOptions) => Stream.Stream<EvalEngineEvent, EvalEngineError>;
}
export class EvalRuntime extends Context.Service<EvalRuntime, EvalRuntimeService>()(
  "@velum-labs/routekit-eval-engine/EvalRuntime"
) {}
export const makeEvalRuntimeLayer = (options: EvalEngineOptions): Layer.Layer<EvalRuntime> =>
  Layer.effect(
    EvalRuntime,
    Effect.gen(function* () {
      const engine: EvalEngineService = yield* Effect.serviceOption(EvalEngine).pipe(
        Effect.flatMap((option) =>
          option._tag === "Some"
            ? Effect.succeed(option.value)
            : EvalEngine.pipe(Effect.provide(makeEvalEngineLayer(options)))
        )
      );
      return EvalRuntime.of({ dryRun: engine.dryRun, run: engine.run });
    })
  );
