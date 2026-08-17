import { sleep } from "workflow";

import {
  launchSandboxJob,
  pollSandboxJob,
  type LaunchedSandboxJob,
  type SandboxJobPollResult
} from "@/lib/sandbox-job";

async function launch(jobId: string, workerId: string): Promise<LaunchedSandboxJob> {
  "use step";

  return launchSandboxJob(jobId, workerId);
}

async function poll(launched: LaunchedSandboxJob): Promise<SandboxJobPollResult> {
  "use step";

  return pollSandboxJob(launched);
}

export async function runSandboxJobWorkflow(jobId: string, workerId: string): Promise<void> {
  "use workflow";

  let attempt = 1;
  while (attempt <= 5) {
    const launched = await launch(jobId, `${workerId}-${attempt}`);
    if (launched.state === "terminal") return;
    if (launched.state === "deferred") {
      await sleep("20s");
      continue;
    }
    while (true) {
      const result = await poll(launched);
      if (result === "running") {
        await sleep("20s");
        continue;
      }
      if (result !== "retry") return;
      await sleep(`${Math.min(10 * 2 ** attempt, 300)}s`);
      attempt += 1;
      break;
    }
  }
}
