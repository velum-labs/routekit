import { Option } from "effect";

import type { EvalComparison } from "../baseline/index.js";
import type { EvalHistoryEntry } from "../history/index.js";
import type { EvalResultRow, EvalTestRow } from "../model.js";
import { failureSection } from "./failures.js";
import { comparisonSection, trendSection } from "./history-sections.js";
import {
  footerSection,
  judgeSection,
  modelSection,
  provenanceSection,
  testSection
} from "./sections.js";

export const renderRouteKitEvalReport = (input: {
  readonly comparison?: EvalComparison;
  readonly files: readonly string[];
  readonly generatedAt: string;
  readonly history: readonly EvalHistoryEntry[];
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}): string => {
  const sections = [
    provenanceSection(input),
    modelSection(input.results, input.tests),
    testSection(input.tests),
    failureSection(input.results),
    judgeSection(input.results),
    comparisonSection(
      input.comparison === undefined ? Option.none() : Option.some(input.comparison)
    ),
    trendSection(input.history),
    footerSection(input)
  ];
  return `${sections
    .filter((section) => section.length > 0)
    .map((section) => section.join("\n"))
    .join("\n\n")}\n`;
};

export { CONTRADICTED, formatCorrectness, rollUpModels } from "./correctness.js";
export {
  cell,
  fileName,
  formatCost,
  formatDuration,
  formatPercent,
  quote,
  table,
  UNMEASURED
} from "./format.js";
