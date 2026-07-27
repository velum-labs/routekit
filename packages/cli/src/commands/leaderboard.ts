import { CliError, contextFor } from "@velum-labs/routekit-cli-core";
import type { RouteKitLeaderboard } from "@velum-labs/routekit-control";
import { formatUsd } from "@velum-labs/routekit-gateway";
import { ControlError } from "@velum-labs/routekit-runtime";
import type { Command } from "commander";

import { routekitClient } from "../client.js";

function parseBy(value: string): "principal" | "model" | "provider" {
  if (value === "principal" || value === "model" || value === "provider") {
    return value;
  }
  throw new CliError({
    code: "bad_request",
    message: `--by must be one of: principal, model, provider`
  });
}

function parseSort(
  value: string
): "cost" | "requests" | "tokens" | "errors" | "latency" {
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

function costText(row: RouteKitLeaderboard["rows"][number]): string {
  if (row.estimateUsd !== undefined) {
    const base = formatUsd(row.estimateUsd);
    return row.unknownCostCount > 0
      ? `${base} (+${row.unknownCostCount} unknown)`
      : base;
  }
  return row.unknownCostCount > 0 ? `${row.unknownCostCount} unknown` : "$0.00";
}

function formatRow(row: RouteKitLeaderboard["rows"][number]): string {
  const name = row.label !== undefined ? `${row.label} (${row.key})` : row.key;
  const latency =
    row.latencyMsAvg !== undefined
      ? ` avg=${Math.round(row.latencyMsAvg)}ms`
      : "";
  return [
    `${String(row.rank).padStart(2)}. ${name}`,
    `   requests=${row.requests} ok=${row.success} err=${row.error} tokens=${row.tokensTotal} cost=${costText(row)}${latency}`
  ].join("\n");
}

function renderLeaderboard(board: RouteKitLeaderboard): string[] {
  const lines = [
    `leaderboard by=${board.by} sort=${board.sort} source=${board.source}`,
    `window ${board.window.start} → ${board.window.end}`,
    `sample=${board.sampleSize}${board.truncated ? " (truncated)" : ""} durable=${
      board.budget.durable ? "on" : "off"
    } liveLimit=${board.budget.liveLimit} liveTtlHours=${board.budget.liveTtlHours}`,
    ""
  ];
  if (board.rows.length === 0) {
    lines.push("no attributed calls in this window");
    return lines;
  }
  for (const row of board.rows) {
    lines.push(formatRow(row));
  }
  return lines;
}

export function registerLeaderboard(program: Command): void {
  program
    .command("leaderboard")
    .description("rank principals, models, or providers by retained call usage")
    .option(
      "--by <dimension>",
      "rank dimension: principal, model, or provider",
      "principal"
    )
    .option(
      "--sort <metric>",
      "sort metric: cost, requests, tokens, errors, or latency",
      "cost"
    )
    .option("--limit <n>", "maximum rows to show", "20")
    .option(
      "--window <window>",
      "live retained calls, or durable 1h / 24h / 7d rollups",
      "live"
    )
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = contextFor(command);
      const by = parseBy(String(options.by ?? "principal"));
      const sort = parseSort(String(options.sort ?? "cost"));
      const limit = parseLimit(String(options.limit ?? "20"));
      const window = parseWindow(String(options.window ?? "live"));
      let board: RouteKitLeaderboard;
      try {
        board = await (await routekitClient()).call("calls.leaderboard", {
          by,
          sort,
          limit,
          window
        });
      } catch (error) {
        if (error instanceof ControlError) {
          throw new CliError({
            code: error.code,
            message: error.message,
            hint:
              window === "live"
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
