import { Schema } from "effect";

import { REASONING_EFFORTS } from "../../../author/src/reasoning-effort.ts";

export {
  harnessEffortFlag,
  type ReasoningEffort,
} from "../../../author/src/reasoning-effort.ts";

// Derived from the author tuple rather than re-listed: a `satisfies` check on a
// hand-written list accepts a subset, so a new effort would decode-fail here
// while typecheck stayed green.
export const ReasoningEffortSchema = Schema.Literals(REASONING_EFFORTS);
