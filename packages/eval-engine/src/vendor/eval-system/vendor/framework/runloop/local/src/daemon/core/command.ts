import type { AgentRunnerCommand } from "../../agent-runner/service.ts";
import type {
  RouteKitEvalDaemonServices,
  RuntimeCommand,
} from "./types.ts";
import type { InvocationCancellation } from "../invoke/invoke.ts";

import { projectAgentInvocationCore } from "../../../../../contracts/internal/src/runtime/command-types.ts";

const FEATURES_DIR = "features";

// The runner requires a definite features root: an explicit client request
// wins, then the daemon's configured root; the final fallback is the daemon
// process's own cwd (the daemon owner controls it).
export const makeRunnerCommand = (input: {
  readonly cancellation: InvocationCancellation | undefined;
  readonly command: RuntimeCommand;
  readonly cwd: string;
  readonly services: RouteKitEvalDaemonServices;
}): AgentRunnerCommand => ({
  ...projectAgentInvocationCore(input.command),
  cancelState: input.cancellation?.cancelled,
  cancelSignal: input.cancellation?.signal,
  cwd: input.cwd,
  featuresRoot:
    input.command.featuresRoot ??
    input.services.defaultFeaturesRoot ??
    `${input.services.defaultCwd}/${FEATURES_DIR}`,
});
