import { defineHarness } from "../../routekit-eval/src/index.ts";

import { claudeHarness } from "./harness.ts";

export const harness = defineHarness(claudeHarness);
