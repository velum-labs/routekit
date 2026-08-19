import {
  CliError,
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { dim, renderTableLines } from "@velum-labs/routekit-cli-ui";
import type { RouteKitLeaderboard } from "@velum-labs/routekit-control";
import { formatUsd } from "@velum-labs/routekit-gateway";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { withCliClient } from "../../cli-client.js";
import { routekitRoot } from "../root-command.js";

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
  return by === "principal" ? (row.label ?? row.key) : row.key;
}

function costText(row: RouteKitLeaderboard["rows"][number]): string {
  if (row.estimateUsd !== undefined) {
    const base = formatUsd(row.estimateUsd);
    return row.unknownCostCount > 0 ? `${base}*` : base;
  }
  return row.unknownCostCount > 0 ? "unknown" : "$0.00";
}

function latencyText(row: RouteKitLeaderboard["rows"][number]): string {
  return row.latencyMsAvg === undefined ? "—" : `${Math.round(row.latencyMsAvg)}ms`;
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
  return sameDay
    ? `${fmt(start).slice(11, 19)} → ${fmt(end)}`
    : `${fmt(start)} → ${fmt(end)}`;
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
      for (const row of labeled) lines.push(dim(`  ${row.label} · token ${row.key}`));
    }
  }
  return lines;
}

export const makeLeaderboardCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make(
    "leaderboard",
    {
      by: Flag.choice("by", ["principal", "model", "provider"] as const).pipe(
        Flag.withDefault("principal"),
        Flag.withDescription("rank dimension: principal, model, or provider")
      ),
      sort: Flag.choice(
        "sort",
        ["cost", "requests", "tokens", "errors", "latency"] as const
      ).pipe(
        Flag.withDefault("cost"),
        Flag.withDescription("sort metric: cost, requests, tokens, errors, or latency")
      ),
      limit: Flag.integer("limit").pipe(
        Flag.withDefault(20),
        Flag.withDescription("maximum rows to show")
      ),
      window: Flag.choice("window", ["live", "1h", "24h", "7d"] as const).pipe(
        Flag.optional,
        Flag.map(Option.getOrUndefined),
        Flag.withDescription(
          "live retained calls, or durable 1h / 24h / 7d rollups (defaults to longest retained window)"
        )
      )
    },
    ({ by, limit, sort, window }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const board = yield* withCliClient((client) =>
          client.call("calls.leaderboard", {
            by,
            sort,
            limit,
            ...(window !== undefined ? { window } : {})
          })
        ).pipe(
          Effect.catch((error) =>
            error instanceof ControlError
              ? Effect.fail(
                  new CliError({
                    code: error.code,
                    message: error.message,
                    hint:
                      window === undefined || window === "live"
                        ? "Call attribution is retained by the current daemon for a bounded period."
                        : "Enable leaderboard.durable: true in router.yaml for historical windows.",
                    tryCommand: "routekit status"
                  })
                )
              : Effect.fail(error)
          )
        );
        if (ctx.json) ctx.emit(board);
        else for (const line of renderLeaderboard(board)) ctx.presenter.line(line);
      })
  ).pipe(
    Command.withDescription("rank principals, models, or providers by retained call usage")
  );
