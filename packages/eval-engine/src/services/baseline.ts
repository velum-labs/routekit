import { Context, Effect, Layer, Option } from "effect";

import type { EvalBaselineSelector, EvalComparison } from "../baseline/index.js";
import { compareEvalRun, selectEvalBaseline } from "../baseline/index.js";
import type { EvalHistoryEntry } from "../history/index.js";

export interface EvalBaselineService {
  readonly compare: (input: {
    readonly current: EvalHistoryEntry;
    readonly files: readonly string[];
    readonly history: readonly EvalHistoryEntry[];
    readonly selector: EvalBaselineSelector;
  }) => Effect.Effect<Option.Option<EvalComparison>>;
}
export class EvalBaseline extends Context.Service<EvalBaseline, EvalBaselineService>()(
  "@velum-labs/routekit-eval-engine/EvalBaseline"
) {}
export const EvalBaselineLive = Layer.succeed(EvalBaseline)(
  EvalBaseline.of({
    compare: (input) =>
      Effect.succeed(
        Option.map(selectEvalBaseline(input), (baseline) =>
          compareEvalRun({ baseline, current: input.current, selector: input.selector })
        )
      )
  })
);
