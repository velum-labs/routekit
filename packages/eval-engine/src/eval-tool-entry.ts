#!/usr/bin/env node

import path from "node:path";

import { applyHostProviderEnv } from "./host-env.ts";
import { runEvalTool } from "./eval-tool.ts";

const environment: NodeJS.ProcessEnv = { ...process.env };
applyHostProviderEnv(environment);
const result = await runEvalTool({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  environment,
  homeDirectory:
    environment.ORI_EVAL_TOOL_HOME ??
    environment.HOME ??
    path.join(process.cwd(), ".ori-eval-home"),
});
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
