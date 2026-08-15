import { Option } from "effect";

import type { EvalResultRow } from "../model.js";

const FAILED_TERMINAL_TYPES = new Set(["session.failed", "turn.failed"]);

export type { EvalResultRow } from "../model.js";

export const runModel = (row: EvalResultRow): string => row.terminal?.model ?? row.model;
export const isFailedRun = (row: EvalResultRow): boolean =>
  row.terminal !== undefined && FAILED_TERMINAL_TYPES.has(row.terminal.type);
export const isJudgeRun = (row: EvalResultRow): boolean => row.role === "judge";
export const isCandidateRun = (row: EvalResultRow): boolean => !isJudgeRun(row);
export const isCompletedRun = (row: EvalResultRow): boolean => !row.cutOff;

export const runErrorText = (row: EvalResultRow): Option.Option<string> => {
  const payload = row.terminal?.payload;
  if (typeof payload !== "object" || payload === null) return Option.none();
  const record = payload as Record<string, unknown>;
  const failure = record.failure;
  if (typeof failure === "object" && failure !== null) {
    const message = (failure as Record<string, unknown>).message;
    if (typeof message === "string") return Option.some(message);
  }
  return typeof record.error === "string" ? Option.some(record.error) : Option.none();
};

export const totalCostUsd = (rows: readonly EvalResultRow[]): number | undefined => {
  const measured = rows.flatMap((row) =>
    row.usage?.costUsd === undefined ? [] : [row.usage.costUsd]
  );
  return measured.length === 0 ? undefined : measured.reduce((total, cost) => total + cost, 0);
};
