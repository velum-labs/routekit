import { Context, Effect, FileSystem, Layer, Path } from "effect";

import type { EvalComparison } from "../baseline/index.js";
import type { EvalHistoryEntry } from "../history/index.js";
import type { EvalResultRow, EvalTestRow } from "../model.js";
import { renderRouteKitEvalReport } from "../reporting/index.js";

export interface EvalReportInput {
  readonly comparison?: EvalComparison;
  readonly files: readonly string[];
  readonly generatedAt: string;
  readonly history: readonly EvalHistoryEntry[];
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}
export interface EvalReporterService {
  readonly render: (input: EvalReportInput) => Effect.Effect<string>;
  readonly write: (
    path: string,
    input: EvalReportInput
  ) => Effect.Effect<string, never, FileSystem.FileSystem | Path.Path>;
}
export class EvalReporter extends Context.Service<EvalReporter, EvalReporterService>()(
  "@velum-labs/routekit-eval-engine/EvalReporter"
) {}
export const EvalReporterLive = Layer.succeed(EvalReporter)(
  EvalReporter.of({
    render: (input) => Effect.succeed(renderRouteKitEvalReport(input)),
    write: (target, input) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, renderRouteKitEvalReport(input));
        return target;
      }).pipe(Effect.orDie)
  })
);
