import {
  CliError,
  type CliRuntime,
  contextFor,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { dim, renderTableLines } from "@velum-labs/routekit-cli-ui";
import type { RouteKitLeaderboard } from "@velum-labs/routekit-control";
import { formatUsd } from "@velum-labs/routekit-gateway";
import { ControlError } from "@velum-labs/routekit-runtime";
import type { Command } from "commander";
import { runCliClient } from "../cli-session.js";

function parseBy(value: string): "principal" | "model" | "provider" {
  if (value === "principal" || value === "model" || value === "provider") {
    return value;
  }
  throw new CliError({
    code: "bad_request",
    message: `--by must be one of: principal, model, provider`
  });
}

function parseSort(value: string): "cost" | "requests" | "tokens" | "errors" | "latency" {
  if (
    value === "cost" ||
    value === "requests" ||
    value === "tokens" ||
    value === "errors" ||
    value === "latency"
  ) {
    return value;
  }
  throw new CliError({
    code: "bad_request",
    message: `--sort must be one of: cost, requests, tokens, errors, latency`
  });
}

function parseWindow(value: string): "live" | "1h" | "24h" | "7d" {
  if (value === "live" || value === "1h" || value === "24h" || value === "7d") {
    return value;
  }
  throw new CliError({
    code: "bad_request",
    message: `--window must be one of: live, 1h, 24h, 7d`
  });
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliError({
      code: "bad_request",
      message: `--limit must be a positive integer`
    });
  }
  return parsed;
}

function dimensionTitle(by: RouteKitLeaderboard["by"]): string {
  switch (by) {
    case "principal":
      return "client";
    case "model":
      return "model";
    case "provider":
      return "provider";
  }
}

function rowName(row: RouteKitLeaderboard["rows"][number], by: RouteKitLeaderboard["by"]): string {
  if (by === "principal") {
    return row.label ?? row.key;
  }
  return row.key;
}

function costText(row: RouteKitLeaderboard["rows"][number]): string {
  if (row.estimateUsd !== undefined) {
    const base = formatUsd(row.estimateUsd);
    return row.unknownCostCount > 0 ? `${base}*` : base;
  }
  return row.unknownCostCount > 0 ? "unknown" : "$0.00";
}

function latencyText(row: RouteKitLeaderboard["rows"][number]): string {
  if (row.latencyMsAvg === undefined) return "—";
  return `${Math.round(row.latencyMsAvg)}ms`;
}

function formatWindow(board: RouteKitLeaderboard): string {
  if (board.source === "live") return "live retained calls";
  const start = new Date(board.window.start);
  const end = new Date(board.window.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${board.window.start} → ${board.window.end}`;
  }
  const sameDay = start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
  const fmt = (value: Date): string =>
    value
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, " UTC");
  if (sameDay) {
    return `${fmt(start).slice(11, 19)} → ${fmt(end)}`;
  }
  return `${fmt(start)} → ${fmt(end)}`;
}

export function renderLeaderboard(board: RouteKitLeaderboard): string[] {
  const lines = [
    "RouteKit leaderboard",
    "",
    `  ${dimensionTitle(board.by)} · sorted by ${board.sort} · ${formatWindow(board)}`,
    dim(
      `  ${board.sampleSize} call${board.sampleSize === 1 ? "" : "s"}${
        board.truncated ? " · truncated" : ""
      } · ${board.source}${board.budget.durable ? " · durable on" : ""}`
    ),
    ""
  ];
  if (board.rows.length === 0) {
    lines.push("  no attributed calls in this window");
    return lines;
  }
  const rows = board.rows.map((row) => [
    String(row.rank),
    rowName(row, board.by),
    String(row.requests),
    String(row.tokensTotal),
    costText(row),
    `${row.success}/${row.error}`,
    latencyText(row)
  ]);
  lines.push(
    ...renderTableLines(rows, {
      head: ["#", dimensionTitle(board.by), "reqs", "tokens", "cost", "ok/err", "latency"],
      indent: 2,
      align: ["right", "left", "right", "right", "right", "right", "right"]
    })
  );
  if (board.rows.some((row) => row.unknownCostCount > 0 && row.estimateUsd !== undefined)) {
    lines.push(dim("  * includes some calls with unknown cost"));
  }
  if (board.by === "principal") {
    const labeled = board.rows.filter((row) => row.label !== undefined);
    if (labeled.length > 0) {
      lines.push("");
      for (const row of labeled) {
        lines.push(dim(`  ${row.label} · token ${row.key}`));
      }
    }
  }
  return lines;
}

export function registerLeaderboard(
  program: Command,
  runtime: CliRuntime = processCliRuntime
): void {
  program
    .command("leaderboard")
    .description("rank principals, models, or providers by retained call usage")
    .option("--by <dimension>", "rank dimension: principal, model, or provider", "principal")
    .option("--sort <metric>", "sort metric: cost, requests, tokens, errors, or latency", "cost")
    .option("--limit <n>", "maximum rows to show", "20")
    .option(
      "--window <window>",
      "live retained calls, or durable 1h / 24h / 7d rollups (defaults to longest retained window)"
    )
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = contextFor(command, runtime);
      const by = parseBy(String(options.by ?? "principal"));
      const sort = parseSort(String(options.sort ?? "cost"));
      const limit = parseLimit(String(options.limit ?? "20"));
      const window = options.window === undefined ? undefined : parseWindow(String(options.window));
      let board: RouteKitLeaderboard;
      try {
        board = await runCliClient((client) =>
          client.call("calls.leaderboard", {
            by,
            sort,
            limit,
            ...(window !== undefined ? { window } : {})
          })
        );
      } catch (error) {
        if (error instanceof ControlError) {
          throw new CliError({
            code: error.code,
            message: error.message,
            hint:
              window === undefined || window === "live"
                ? "Call attribution is retained by the current daemon for a bounded period."
                : "Enable leaderboard.durable: true in router.yaml for historical windows.",
            tryCommand: "routekit status"
          });
        }
        throw error;
      }
      if (ctx.json) {
        ctx.emit(board);
        return;
      }
      for (const line of renderLeaderboard(board)) {
        ctx.presenter.line(line);
      }
    });
}
