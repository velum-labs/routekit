import path from "node:path";

export const COPY_IGNORE_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".routekit-eval",
  ".turbo",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

export const MAX_PRIVATE_COPY_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_PRIVATE_COPY_FILES = 200_000;

const CLARIFICATION =
  /\b(what do you mean|can you (?:explain|clarify|repeat|rephrase)|i don'?t understand|why (?:are you|do you)|could you (?:repeat|rephrase|explain)|wait,? what|huh)\b/iu;
const COMPLAINT =
  /\b(this is (?:wrong|broken|stupid)|i didn'?t (?:ask|want)|stop asking|not what i (?:wanted|asked))\b/iu;

export const replaceBakeoff = (text: string): string =>
  text.replaceAll(/\bbakeoff\b/giu, "model comparison");

export const isInsideRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export const parseQuestionOptions = (
  questionText: string,
): {
  readonly options: readonly string[];
  readonly prompt: string;
} => {
  const lines = questionText.trim().split("\n");
  const numbered: string[] = [];
  const promptLines: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:\d+[\.)]|[-*])\s+(.*)$/u.exec(line);
    if (match?.[1] !== undefined) {
      numbered.push(match[1].trim());
      continue;
    }
    promptLines.push(line);
  }
  const concrete = numbered.filter((option) => !/^other\b/iu.test(option)).slice(0, 3);
  const prompt = promptLines
    .join("\n")
    .replace(/^\[[^\]]+\]\s*/u, "")
    .trim();
  return { options: concrete, prompt };
};

export const tableHeaderRow = (context: string): string | undefined => {
  const header = context.split("\n").find((line) => {
    const trimmed = line.trim();
    return /^\|.*\|$/u.test(trimmed) && !/^\|[\s:-]+\|$/u.test(trimmed);
  });
  return header?.trim();
};

export const classifySpawnReply = (input: {
  readonly questionText: string;
  readonly reply: string;
}): "answer" | "not-an-answer" => {
  const reply = input.reply.trim();
  if (reply === "") return "not-an-answer";
  const { options } = parseQuestionOptions(input.questionText);
  const normalized = reply.toLowerCase();
  for (const [index, option] of options.entries()) {
    const number = String(index + 1);
    if (
      normalized === number ||
      normalized.startsWith(`${number}.`) ||
      normalized.startsWith(`${number})`) ||
      normalized === option.toLowerCase() ||
      normalized.startsWith(`${option.toLowerCase()} `)
    ) {
      return "answer";
    }
  }
  if (/^(?:other|4)(?:\b|[.:,])/iu.test(normalized)) return "answer";
  if (CLARIFICATION.test(reply) || COMPLAINT.test(reply)) return "not-an-answer";
  if (/\?\s*$/u.test(reply) && reply.split(/\s+/u).length <= 24) return "not-an-answer";
  return "answer";
};

const formatDuration = (durationMs: number): string => {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
};

const formatCost = (costUsd: number | undefined): string =>
  costUsd === undefined ? "unmeasured" : `$${costUsd.toFixed(2)}`;

const formatClock = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(11, 16);
};

export const attemptStepLabel = (input: {
  readonly index: number;
  readonly isLast: boolean;
  readonly stoppedForQuestion: boolean;
}): string => {
  if (input.stoppedForQuestion) {
    return input.index === 0
      ? "Reading the project, stopped to ask you a question"
      : "Reading the project again after your answer, stopped to ask you a question";
  }
  if (input.isLast) return "Reading the project";
  return input.index === 0
    ? "Reading the project, stopped to ask you a question"
    : "Reading the project again after your answer";
};

export const renderCostTable = (input: {
  readonly attempts: readonly {
    readonly startedAt: string;
    readonly summary?: { readonly costUsd?: number; readonly durationMs?: number };
  }[];
  readonly candidateCostUsd?: number;
  readonly candidateDurationMs?: number;
  readonly judgeCostUsd?: number;
  readonly judgeDurationMs?: number;
  readonly stoppedForQuestion: boolean;
  readonly totalCostUsd?: number;
  readonly unmeasuredAttempts: number;
}): string => {
  const rows: string[] = [
    "| Step | Start | Duration | Cost |",
    "| -- | -- | -- | -- |",
  ];
  for (const [index, attempt] of input.attempts.entries()) {
    const isLast = index === input.attempts.length - 1;
    const label = attemptStepLabel({
      index,
      isLast,
      stoppedForQuestion: isLast && input.stoppedForQuestion,
    });
    rows.push(
      `| ${label} | observed ${formatClock(attempt.startedAt)} | ${
        attempt.summary?.durationMs === undefined
          ? "unmeasured"
          : formatDuration(attempt.summary.durationMs)
      } | ${formatCost(attempt.summary?.costUsd)} |`,
    );
  }
  if (input.candidateDurationMs !== undefined || input.candidateCostUsd !== undefined) {
    rows.push(
      `| Eval model calls |  | ${
        input.candidateDurationMs === undefined
          ? "unmeasured"
          : formatDuration(input.candidateDurationMs)
      } | ${formatCost(input.candidateCostUsd)} |`,
    );
  }
  if (input.judgeDurationMs !== undefined || input.judgeCostUsd !== undefined) {
    rows.push(
      `| Judging |  | ${
        input.judgeDurationMs === undefined ? "unmeasured" : formatDuration(input.judgeDurationMs)
      } | ${formatCost(input.judgeCostUsd)} |`,
    );
  }
  const totalLabel =
    input.totalCostUsd === undefined
      ? "unmeasured"
      : input.unmeasuredAttempts > 0
        ? `**$${input.totalCostUsd.toFixed(2)} (floor)**`
        : `**$${input.totalCostUsd.toFixed(2)}**`;
  rows.push(`| **Total** |  |  | ${totalLabel} |`);
  return rows.join("\n");
};

export const cheaperRerunLine = (input: {
  readonly evalCostUsd?: number;
  readonly totalCostUsd?: number;
}): string => {
  if (input.totalCostUsd === undefined && input.evalCostUsd === undefined) {
    return "A rerun costs only the amount shown in RouteKitEval's closing table; this run's total is unmeasured.";
  }
  if (input.totalCostUsd === undefined) {
    return `A rerun costs only ${formatCost(input.evalCostUsd)}.`;
  }
  if (input.evalCostUsd === undefined) {
    return `The run cost ${formatCost(input.totalCostUsd)} in total, and a rerun costs only the amount shown in RouteKitEval's closing table.`;
  }
  return `The run cost ${formatCost(input.totalCostUsd)} in total, and a rerun costs only ${formatCost(input.evalCostUsd)}.`;
};
