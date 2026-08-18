import {
  ClassificationPrediction as ClassificationPredictionSchema,
  type ClassificationPrediction
} from "@velum-labs/routekit-eval-contracts";
import { Schema } from "effect";

export type LabeledClassificationPrediction = {
  treatmentId: string;
  taskId: string;
  seed: number;
  expectedScope?: string;
  expectedArea?: string;
  expectedAreas?: readonly string[];
  prediction: ClassificationPrediction;
};

export type ProportionMetric = {
  correct: number;
  total: number;
  rate: number;
  confidence95Low: number;
  confidence95High: number;
};

export type ClassificationTreatmentMetrics = {
  treatmentId: string;
  predictions: number;
  scopeHitAt1?: ProportionMetric;
  meanScopeBrier?: number;
  areaHitAt1?: ProportionMetric;
  allGoldAt3?: ProportionMetric;
  exactSetAtPointFive?: ProportionMetric;
  meanAreaBrier?: number;
  medianLatencyMs: number;
  providerCostUsd: number;
  infrastructureCostUsd: number;
};

export type ClassificationPredictionDefaults = Pick<
  ClassificationPrediction,
  "latencyMs" | "providerCostUsd" | "infrastructureCostUsd" | "provenance"
>;

function normalizeLunaDistribution(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  if (object.scopeProbabilities !== undefined || object.areaProbabilities !== undefined) {
    return value;
  }
  const scope = object.scope_probabilities;
  const areas = object.area_probabilities_given_known ?? object.area_assessments;
  if (typeof scope !== "object" || scope === null || !Array.isArray(areas)) return value;

  const areaProbabilities: Record<string, number> = {};
  for (const candidate of areas) {
    if (typeof candidate !== "object" || candidate === null) return value;
    const area = candidate as Record<string, unknown>;
    const areaId = area.area_id ?? area.areaId;
    const probability =
      area.probability_required ??
      area.probabilityRequired ??
      area.probabilityRequiredGivenKnown;
    if (typeof areaId !== "string" || typeof probability !== "number") return value;
    areaProbabilities[areaId] = probability;
  }
  const rankedAreas = Object.entries(areaProbabilities)
    .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))
    .map(([areaId]) => areaId);
  return {
    scopeProbabilities: scope,
    areaProbabilities,
    rankedAreas
  };
}

function decodePrediction(
  value: unknown,
  defaults: ClassificationPredictionDefaults | undefined
): ClassificationPrediction | undefined {
  try {
    const normalized = normalizeLunaDistribution(value);
    if (defaults === undefined || typeof value !== "object" || value === null) {
      return Schema.decodeUnknownSync(ClassificationPredictionSchema)(normalized);
    }
    const object = normalized as Record<string, unknown>;
    const provenance =
      typeof object.provenance === "object" && object.provenance !== null
        ? { ...defaults.provenance, ...(object.provenance as Record<string, unknown>) }
        : defaults.provenance;
    return Schema.decodeUnknownSync(ClassificationPredictionSchema)({
      ...object,
      latencyMs: object.latencyMs ?? defaults.latencyMs,
      providerCostUsd: object.providerCostUsd ?? defaults.providerCostUsd,
      infrastructureCostUsd: object.infrastructureCostUsd ?? defaults.infrastructureCostUsd,
      provenance
    });
  } catch {
    return undefined;
  }
}

function parseJsonContent(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const fenced = trimmed.length >= 6 && trimmed.startsWith("```") && trimmed.endsWith("```");
  const bodyStart = fenced && trimmed.slice(3, 7).toLowerCase() === "json" ? 7 : 3;
  const candidate = fenced ? trimmed.slice(bodyStart, -3).trim() : trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

function openAiResponseContent(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as Record<string, unknown>;
  const response =
    typeof object.response === "object" && object.response !== null
      ? (object.response as Record<string, unknown>)
      : object;
  const choices = response.choices;
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

export function extractClassificationPrediction(
  value: unknown,
  defaults?: ClassificationPredictionDefaults,
  maximumDepth = 4
): ClassificationPrediction | undefined {
  const visit = (candidate: unknown, depth: number): ClassificationPrediction | undefined => {
    const direct = decodePrediction(candidate, defaults);
    if (direct !== undefined || depth >= maximumDepth) return direct;

    if (typeof candidate === "string") {
      const parsed = parseJsonContent(candidate);
      return parsed === undefined ? undefined : visit(parsed, depth + 1);
    }
    if (typeof candidate !== "object" || candidate === null) return undefined;

    const object = candidate as Record<string, unknown>;
    for (const key of ["prediction", "result", "output"] as const) {
      if (object[key] === undefined) continue;
      const nested = visit(object[key], depth + 1);
      if (nested !== undefined) return nested;
    }

    const content = openAiResponseContent(object);
    if (content === undefined) return undefined;
    const parsed = parseJsonContent(content);
    return parsed === undefined ? undefined : visit(parsed, depth + 1);
  };

  return visit(value, 0);
}

function wilson(correct: number, total: number): ProportionMetric {
  if (total === 0) {
    return { correct, total, rate: 0, confidence95Low: 0, confidence95High: 0 };
  }
  const z = 1.959963984540054;
  const rate = correct / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total))) / denominator;
  return {
    correct,
    total,
    rate,
    confidence95Low: Math.max(0, center - margin),
    confidence95High: Math.min(1, center + margin)
  };
}

function firstRankedProbability(
  probabilities: Readonly<Record<string, number>>
): string | undefined {
  return Object.entries(probabilities).sort(
    ([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId)
  )[0]?.[0];
}

function brier(
  probabilities: Readonly<Record<string, number>>,
  expected: ReadonlySet<string>
): number {
  const labels = new Set([...Object.keys(probabilities), ...expected]);
  let total = 0;
  for (const label of labels) {
    const probability = probabilities[label] ?? 0;
    const observed = expected.has(label) ? 1 : 0;
    total += (probability - observed) ** 2;
  }
  return total;
}

function expectedAreaSet(entry: LabeledClassificationPrediction): ReadonlySet<string> | undefined {
  const values = [
    ...(entry.expectedAreas ?? []),
    ...(entry.expectedArea === undefined ? [] : [entry.expectedArea])
  ];
  return values.length === 0 ? undefined : new Set(values);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function evaluateClassificationPredictions(
  entries: readonly LabeledClassificationPrediction[]
): ClassificationTreatmentMetrics[] {
  const grouped = new Map<string, LabeledClassificationPrediction[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.treatmentId) ?? [];
    current.push(entry);
    grouped.set(entry.treatmentId, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([treatmentId, predictions]) => {
      const scope = predictions.filter(
        (entry): entry is LabeledClassificationPrediction & { expectedScope: string } =>
          entry.expectedScope !== undefined
      );
      const area = predictions.flatMap((entry) => {
        const expected = expectedAreaSet(entry);
        return expected === undefined ? [] : [{ entry, expected }];
      });
      const scopeCorrect = scope.filter(
        (entry) =>
          firstRankedProbability(entry.prediction.scopeProbabilities) === entry.expectedScope
      ).length;
      const areaCorrect = area.filter(({ entry, expected }) => {
        const first = entry.prediction.rankedAreas[0];
        return first !== undefined && expected.has(first);
      }).length;
      const allGoldAt3Correct = area.filter(({ entry, expected }) => {
        const topThree = new Set(entry.prediction.rankedAreas.slice(0, 3));
        return [...expected].every((areaId) => topThree.has(areaId));
      }).length;
      const exactSetAtPointFiveCorrect = area.filter(({ entry, expected }) => {
        const predicted = new Set(
          Object.entries(entry.prediction.areaProbabilities)
            .filter(([, probability]) => probability >= 0.5)
            .map(([areaId]) => areaId)
        );
        return (
          predicted.size === expected.size && [...expected].every((areaId) => predicted.has(areaId))
        );
      }).length;
      return {
        treatmentId,
        predictions: predictions.length,
        scopeHitAt1: scope.length === 0 ? undefined : wilson(scopeCorrect, scope.length),
        meanScopeBrier:
          scope.length === 0
            ? undefined
            : scope.reduce(
                (sum, entry) =>
                  sum +
                  brier(entry.prediction.scopeProbabilities, new Set([entry.expectedScope])),
                0
              ) / scope.length,
        areaHitAt1: area.length === 0 ? undefined : wilson(areaCorrect, area.length),
        allGoldAt3:
          area.length === 0 ? undefined : wilson(allGoldAt3Correct, area.length),
        exactSetAtPointFive:
          area.length === 0 ? undefined : wilson(exactSetAtPointFiveCorrect, area.length),
        meanAreaBrier:
          area.length === 0
            ? undefined
            : area.reduce(
                (sum, { entry, expected }) =>
                  sum + brier(entry.prediction.areaProbabilities, expected),
                0
              ) / area.length,
        medianLatencyMs: median(predictions.map((entry) => entry.prediction.latencyMs)),
        providerCostUsd: predictions.reduce(
          (sum, entry) => sum + entry.prediction.providerCostUsd,
          0
        ),
        infrastructureCostUsd: predictions.reduce(
          (sum, entry) => sum + entry.prediction.infrastructureCostUsd,
          0
        )
      };
    });
}

function percentage(metric: ProportionMetric | undefined): string {
  if (metric === undefined) return "n/a";
  return `${(metric.rate * 100).toFixed(1)}% (${(metric.confidence95Low * 100).toFixed(
    1
  )}–${(metric.confidence95High * 100).toFixed(1)}%)`;
}

export function renderClassificationMetrics(
  metrics: readonly ClassificationTreatmentMetrics[]
): string {
  if (metrics.length === 0) {
    return "## Classification metrics\n\nNo standardized labeled predictions were available.\n";
  }
  return [
    "## Classification metrics",
    "",
    "Hit-rate values include Wilson 95% confidence intervals. Lower Brier scores are better.",
    "",
    "| Treatment | Predictions | Scope hit@1 | Scope Brier | Area hit@1 | All gold @3 | Exact set @0.5 | Area Brier | Median latency | Total cost |",
    "| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
    ...metrics.map(
      (entry) =>
        `| ${entry.treatmentId} | ${entry.predictions} | ${percentage(
          entry.scopeHitAt1
        )} | ${
          entry.meanScopeBrier === undefined ? "n/a" : entry.meanScopeBrier.toFixed(4)
        } | ${percentage(entry.areaHitAt1)} | ${percentage(
          entry.allGoldAt3
        )} | ${percentage(entry.exactSetAtPointFive)} | ${
          entry.meanAreaBrier === undefined ? "n/a" : entry.meanAreaBrier.toFixed(4)
        } | ${entry.medianLatencyMs.toFixed(0)} ms | $${(
          entry.providerCostUsd + entry.infrastructureCostUsd
        ).toFixed(4)} |`
    ),
    ""
  ].join("\n");
}
