import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import type { StoredEvalRun } from "@velum-labs/routekit-eval-contracts";
import type { Command } from "commander";
import { runCliEffect } from "../cli-session.js";
import {
  evalDiscoverCommand,
  evalDryRunCommand,
  evalListCommand,
  evalRunCommand,
  evalShowCommand
} from "../effect/eval-cli.js";

interface WorkloadOptions {
  workload: string;
  candidate: string;
  judge: string;
  suite?: string;
  inventoryFingerprint?: string;
}

const workloadFrom = (options: WorkloadOptions) => ({
  workloadId: options.workload,
  candidateModel: options.candidate,
  judgeModel: options.judge,
  ...(options.suite === undefined ? {} : { suiteId: options.suite }),
  ...(options.inventoryFingerprint === undefined
    ? {}
    : { inventoryFingerprint: options.inventoryFingerprint })
});

const addWorkloadOptions = (command: Command): Command =>
  command
    .requiredOption("--workload <id>", "stable workload identifier")
    .requiredOption("--candidate <provider/model>", "explicit candidate model ID")
    .requiredOption("--judge <provider/model>", "explicit judge model ID")
    .option("--suite <id>", "suite identifier (defaults to workload)")
    .option("--inventory-fingerprint <digest>", "model inventory fingerprint");

const summarize = (run: StoredEvalRun) => {
  const passed = run.engine.results.filter((result) => result.outcome === "passed").length;
  const failed = run.engine.results.filter((result) => result.outcome === "failed").length;
  return { passed, failed };
};

export function registerEval(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const evalCommand = program
    .command("eval")
    .description("discover and run *.eval.ts workloads against explicit model IDs");
  evalCommand
    .command("discover")
    .description("discover eval files and show the resolved execution root")
    .argument("[path]", "eval file or directory", ".")
    .option("--cwd <path>", "working directory for a single eval file")
    .action(async (path: string, options: { cwd?: string }, command: Command) => {
      const ctx = contextFor(command, runtime);
      const discovery = await runCliEffect(
        evalDiscoverCommand({
          path,
          ...(options.cwd === undefined ? {} : { workingDirectory: options.cwd })
        })
      );
      if (ctx.json) ctx.emit(discovery);
      else {
        ctx.presenter.status(
          "ok",
          discovery.searchRoot,
          `${discovery.files.length} eval file${discovery.files.length === 1 ? "" : "s"}`
        );
      }
    });
  evalCommand
    .command("list")
    .description("list discovered *.eval.ts files without loading them")
    .argument("[path]", "eval file or directory", ".")
    .option("--cwd <path>", "working directory for a single eval file")
    .action(async (path: string, options: { cwd?: string }, command: Command) => {
      const ctx = contextFor(command, runtime);
      const files = await runCliEffect(
        evalListCommand({
          path,
          ...(options.cwd === undefined ? {} : { workingDirectory: options.cwd })
        })
      );
      if (ctx.json) ctx.emit(files);
      else
        runtime.stdout.write(
          files.length === 0 ? "No eval files found.\n" : `${files.join("\n")}\n`
        );
    });
  addWorkloadOptions(
    evalCommand
      .command("dry-run")
      .description("load eval files without running test bodies")
      .argument("[path]", "eval file or directory", ".")
      .option("--cwd <path>", "evaluation working directory")
  ).action(
    async (
      path: string,
      options: WorkloadOptions & { cwd?: string; store?: string },
      command: Command
    ) => {
      const ctx = contextFor(command, runtime);
      const result = await runCliEffect(
        evalDryRunCommand({
          path,
          workload: workloadFrom(options),
          ...(options.cwd === undefined ? {} : { workingDirectory: options.cwd }),
          ...(options.store === undefined ? {} : { storeRoot: options.store }),
          env: runtime.env
        })
      );
      if (ctx.json) ctx.emit(result);
      else ctx.presenter.status("ok", result.runId, `${result.fileCount} eval files loaded`);
    }
  );
  addWorkloadOptions(
    evalCommand
      .command("run")
      .description("run an eval path and persist normalized evidence")
      .argument("[path]", "eval file or directory", ".")
      .option("--cwd <path>", "evaluation working directory")
      .option("--store <path>", "immutable eval evidence directory")
      .option("--token-file <path>", "gateway token file (defaults to RouteKit owner token)")
  )
    .requiredOption("--url <gateway>", "OpenAI-compatible gateway URL")
    .action(
      async (
        path: string,
        options: WorkloadOptions & {
          cwd?: string;
          store?: string;
          tokenFile?: string;
          url: string;
        },
        command: Command
      ) => {
        const ctx = contextFor(command, runtime);
        const result = await runCliEffect(
          evalRunCommand({
            path,
            workload: workloadFrom(options),
            gatewayUrl: options.url,
            ...(options.cwd === undefined ? {} : { workingDirectory: options.cwd }),
            ...(options.store !== undefined ? { storeRoot: options.store } : {}),
            ...(options.tokenFile !== undefined ? { tokenFile: options.tokenFile } : {}),
            env: runtime.env
          })
        );
        const totals = summarize(result);
        if (ctx.json) ctx.emit(result);
        else {
          ctx.presenter.status(
            totals.failed === 0 ? "ok" : "fail",
            result.manifest.runId,
            `${totals.passed} passed / ${totals.failed} failed`
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
      const result = await runCliEffect(
        evalShowCommand({
          runId: options.runId,
          ...(options.store !== undefined ? { storeRoot: options.store } : {}),
          env: runtime.env
        })
      );
      if (ctx.json) ctx.emit(result);
      else {
        const totals = summarize(result);
        ctx.presenter.status(
          totals.failed === 0 ? "ok" : "fail",
          result.manifest.runId,
          `${totals.passed} passed / ${totals.failed} failed`
        );
      }
    });
}
