// Which earlier run this one is held against, and nothing about how the two are
// compared. Split from `baseline.ts` so that file is only about what counts as
// worse: the selector is parsed from a flag, printed back in the line that says
// what was compared, and never looks at a measurement.
import { Option, Schema } from "effect";

const MODEL_SELECTOR_PREFIX = "model:";

/**
 * Which earlier run to compare against.
 *
 * `last` answers the prompt-change direction (I edited my prompt, did it get
 * worse). `model:<slug>` answers the model direction: pin the model you trust and
 * hold everything else against its most recent run. `best` guards against a slow
 * slide that each individual run is too small to show.
 */
const EvalBaselineSelectorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["last", "best"]) }),
  Schema.Struct({
    kind: Schema.Literals(["model"]),
    model: Schema.String
  })
]);

type EvalBaselineSelector = typeof EvalBaselineSelectorSchema.Type;

const DEFAULT_EVAL_BASELINE: EvalBaselineSelector = { kind: "last" };

/**
 * Parse the `--baseline` value. `Option.none()` is a rejected value, which the
 * flag turns into a usage error naming the accepted forms.
 */
export const parseEvalBaselineSelector = (raw: string): Option.Option<EvalBaselineSelector> => {
  const value = raw.trim();
  if (value === "last" || value === "best") {
    return Option.some({ kind: value });
  }
  if (value.startsWith(MODEL_SELECTOR_PREFIX)) {
    const model = value.slice(MODEL_SELECTOR_PREFIX.length).trim();
    return model.length === 0
      ? Option.none()
      : Option.some({
          kind: "model",
          model
        });
  }
  return Option.none();
};

/** The selector as the user wrote it, for the line that says what was compared. */
export const describeEvalBaselineSelector = (selector: EvalBaselineSelector): string =>
  selector.kind === "model" ? `${MODEL_SELECTOR_PREFIX}${selector.model}` : selector.kind;

export type { EvalBaselineSelector };
export { DEFAULT_EVAL_BASELINE, EvalBaselineSelectorSchema };
