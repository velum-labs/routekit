#!/usr/bin/env node

import { runEvalRoutingTestdriveMain } from "../packages/testkit/dist/index.js";
import { normalizeEvalRoutingTestdriveArgv } from "./lib/eval-routing-testdrive-argv.mjs";

process.argv.splice(
  2,
  process.argv.length - 2,
  ...normalizeEvalRoutingTestdriveArgv(process.argv.slice(2))
);
runEvalRoutingTestdriveMain();
