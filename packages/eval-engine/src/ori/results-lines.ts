/**
 * Adapted from Ori's crash-tolerant JSONL result join.
 *
 * Ori source:
 * framework/cli/src/commands/eval/results-lines.ts
 */
import type {
  EvalHostMetadata,
  EvalResultLine,
  EvalResultRow,
  EvalRunLine,
  EvalRunOutcomeLine,
  EvalRunRole,
  EvalRunStartLine,
  EvalTerminalEvent,
  EvalUsage
} from "../model.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const optionalFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const role = (value: unknown): EvalRunRole | undefined =>
  value === "candidate" || value === "judge" ? value : undefined;

const host = (value: unknown): EvalHostMetadata | undefined => {
  if (!isRecord(value)) return undefined;
  return {
    ...(optionalString(value.architecture) === undefined
      ? {}
      : { architecture: optionalString(value.architecture) }),
    ...(optionalString(value.hostname) === undefined
      ? {}
      : { hostname: optionalString(value.hostname) }),
    ...(optionalString(value.nodeVersion) === undefined
      ? {}
      : { nodeVersion: optionalString(value.nodeVersion) }),
    ...(optionalString(value.operatingSystem) === undefined
      ? {}
      : { operatingSystem: optionalString(value.operatingSystem) }),
    ...(optionalString(value.runner) === undefined ? {} : { runner: optionalString(value.runner) })
  };
};

const usage = (value: unknown): EvalUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const decoded = {
    inputTokens: optionalFinite(value.inputTokens),
    outputTokens: optionalFinite(value.outputTokens),
    contextTokens: optionalFinite(value.contextTokens),
    costUsd: optionalFinite(value.costUsd)
  };
  return Object.values(decoded).every((entry) => entry === undefined)
    ? undefined
    : {
        ...(decoded.inputTokens === undefined ? {} : { inputTokens: decoded.inputTokens }),
        ...(decoded.outputTokens === undefined ? {} : { outputTokens: decoded.outputTokens }),
        ...(decoded.contextTokens === undefined ? {} : { contextTokens: decoded.contextTokens }),
        ...(decoded.costUsd === undefined ? {} : { costUsd: decoded.costUsd })
      };
};

const terminal = (value: unknown): EvalTerminalEvent | undefined => {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  return {
    type: value.type,
    ...(optionalString(value.createdAt) === undefined
      ? {}
      : { createdAt: optionalString(value.createdAt) }),
    ...(optionalString(value.harness) === undefined
      ? {}
      : { harness: optionalString(value.harness) }),
    ...(value.model === null || typeof value.model === "string" ? { model: value.model } : {}),
    ...("payload" in value ? { payload: value.payload } : {}),
    ...(optionalString(value.runId) === undefined ? {} : { runId: optionalString(value.runId) }),
    ...(optionalString(value.turnId) === undefined ? {} : { turnId: optionalString(value.turnId) })
  };
};

const terminalUsage = (value: EvalTerminalEvent | undefined): EvalUsage | undefined =>
  isRecord(value?.payload) ? usage(value.payload.usage) : undefined;

const commonMetadata = (value: Record<string, unknown>) => ({
  ...(optionalString(value.suiteId) === undefined
    ? {}
    : { suiteId: optionalString(value.suiteId) }),
  ...(optionalString(value.caseId) === undefined ? {} : { caseId: optionalString(value.caseId) }),
  ...(host(value.host) === undefined ? {} : { host: host(value.host) })
});

const decodeObject = (value: unknown): EvalResultLine | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    (value.outcome === "failed" || value.outcome === "passed") &&
    typeof value.runKey === "string"
  ) {
    return {
      outcome: value.outcome,
      runKey: value.runKey,
      ...(optionalString(value.message) === undefined
        ? {}
        : { message: optionalString(value.message) }),
      ...(optionalFinite(value.score) === undefined ? {} : { score: optionalFinite(value.score) })
    } satisfies EvalRunOutcomeLine;
  }
  if (typeof value.requestedModel === "string" && typeof value.runKey === "string") {
    return {
      requestedModel: value.requestedModel,
      runKey: value.runKey,
      ...(role(value.role) === undefined ? {} : { role: role(value.role) }),
      ...commonMetadata(value)
    } satisfies EvalRunStartLine;
  }
  if (typeof value.model !== "string") return undefined;
  const eventCounts = isRecord(value.eventCounts)
    ? Object.fromEntries(
        Object.entries(value.eventCounts).filter((entry): entry is [string, number] =>
          Number.isFinite(entry[1])
        )
      )
    : undefined;
  const toolCalls = Array.isArray(value.toolCalls)
    ? value.toolCalls.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const decodedTerminal = terminal(value.terminal);
  const decodedUsage = usage(value.usage) ?? terminalUsage(decodedTerminal);
  return {
    model: value.model,
    ...(optionalString(value.runKey) === undefined ? {} : { runKey: optionalString(value.runKey) }),
    ...(role(value.role) === undefined ? {} : { role: role(value.role) }),
    ...commonMetadata(value),
    ...(optionalFinite(value.durationMs) === undefined
      ? {}
      : { durationMs: optionalFinite(value.durationMs) }),
    ...(eventCounts === undefined ? {} : { eventCounts }),
    ...(optionalFinite(value.outputChars) === undefined
      ? {}
      : { outputChars: optionalFinite(value.outputChars) }),
    ...(decodedTerminal === undefined ? {} : { terminal: decodedTerminal }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(decodedUsage === undefined ? {} : { usage: decodedUsage })
  } satisfies EvalRunLine;
};

export const decodeResultLine = (line: string): EvalResultLine | undefined => {
  try {
    return decodeObject(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
};

const isRunLine = (line: EvalResultLine): line is EvalRunLine => "model" in line;
const isStartLine = (line: EvalResultLine): line is EvalRunStartLine => "requestedModel" in line;
const isOutcomeLine = (line: EvalResultLine): line is EvalRunOutcomeLine => "outcome" in line;

interface RecordedOutcome {
  readonly message?: string;
  readonly outcome: "failed" | "passed";
  readonly score?: number;
}

export const joinOutcomes = (lines: readonly EvalResultLine[]): readonly EvalResultRow[] => {
  const byRunKey = new Map<string, RecordedOutcome>();
  for (const line of lines) {
    if (!isOutcomeLine(line) || byRunKey.get(line.runKey)?.outcome === "failed") continue;
    byRunKey.set(line.runKey, {
      ...(line.message === undefined ? {} : { message: line.message }),
      outcome: line.outcome,
      ...((line.score ?? byRunKey.get(line.runKey)?.score) === undefined
        ? {}
        : { score: line.score ?? byRunKey.get(line.runKey)?.score })
    });
  }
  const completed = new Set(
    lines.flatMap((line) => (isRunLine(line) && line.runKey !== undefined ? [line.runKey] : []))
  );
  const starts = new Map(
    lines.flatMap((line): readonly (readonly [string, EvalRunStartLine])[] =>
      isStartLine(line) ? [[line.runKey, line]] : []
    )
  );
  return lines.flatMap((line): readonly EvalResultRow[] => {
    if (isStartLine(line)) {
      return completed.has(line.runKey)
        ? []
        : [
            {
              cutOff: true,
              model: line.requestedModel,
              outcome: "unknown",
              runKey: line.runKey,
              ...(line.role === undefined ? {} : { role: line.role }),
              ...(line.suiteId === undefined ? {} : { suiteId: line.suiteId }),
              ...(line.caseId === undefined ? {} : { caseId: line.caseId }),
              ...(line.host === undefined ? {} : { host: line.host })
            }
          ];
    }
    if (!isRunLine(line)) return [];
    const recorded = line.runKey === undefined ? undefined : byRunKey.get(line.runKey);
    const start = line.runKey === undefined ? undefined : starts.get(line.runKey);
    return [
      {
        ...line,
        ...(line.role !== undefined || start?.role === undefined ? {} : { role: start.role }),
        ...(line.suiteId !== undefined || start?.suiteId === undefined
          ? {}
          : { suiteId: start.suiteId }),
        ...(line.caseId !== undefined || start?.caseId === undefined
          ? {}
          : { caseId: start.caseId }),
        ...(line.host !== undefined || start?.host === undefined ? {} : { host: start.host }),
        cutOff: false,
        outcome: recorded?.outcome ?? "unknown",
        ...(recorded?.message === undefined ? {} : { outcomeDetail: recorded.message }),
        ...(recorded?.score === undefined ? {} : { score: recorded.score })
      }
    ];
  });
};
