import { defineHarness } from "../../routekit-eval/src/index.ts";

import { piHarness } from "./harness/harness.ts";

export const harness = defineHarness(piHarness);
