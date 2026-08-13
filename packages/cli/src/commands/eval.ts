import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import type { Command } from "commander";

import { evalRunCommand, evalShowCommand } from "../effect/eval-cli.js";

export function registerEval(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const evalCommand = program
    .command("eval")
    .description("run offline model evaluations against explicit model IDs");
  evalCommand
    .command("run")
    .description("execute an evaluation suite through the Effect eval runtime")
    .requiredOption("--spec <path>", "eval suite JSON document")
    .requiredOption("--url <gateway>", "OpenAI-compatible gateway URL")
    .requiredOption("--token <token>", "dedicated eval data-plane token")
    .option("--store <path>", "immutable eval store directory")
    .action(
      async (options: { spec: string; url: string; token: string; store?: string }, command: Command) => {
        const ctx = contextFor(command, runtime);
        const result = await runRouteKitEffect(
          evalRunCommand({
            specPath: options.spec,
            gatewayUrl: options.url,
            token: options.token,
            ...(options.store !== undefined ? { storeRoot: options.store } : {}),
            env: runtime.env
          })
        );
        if (ctx.json) ctx.emit(result);
        else {
          ctx.presenter.status(
            result.failed === 0 ? "ok" : "fail",
            result.runId,
            `${result.passed} passed / ${result.failed} failed`
          );
        }
      }
    );
  evalCommand
    .command("show")
    .description("read an immutable raw evaluation run")
    .requiredOption("--run-id <id>", "eval run id")
    .option("--store <path>", "immutable eval store directory")
    .action(async (options: { runId: string; store?: string }, command: Command) => {
      const ctx = contextFor(command, runtime);
      const result = await runRouteKitEffect(
        evalShowCommand({
          runId: options.runId,
          ...(options.store !== undefined ? { storeRoot: options.store } : {}),
          env: runtime.env
        })
      );
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.status(
          result.failed === 0 ? "ok" : "fail",
          result.runId,
          `${result.passed} passed / ${result.failed} failed`
        );
      }
    });
}
