#!/usr/bin/env node

import { applyHostProviderEnv } from "./host-env";

applyHostProviderEnv();

const { runEvalSystem } = await import("./main");
await runEvalSystem();
