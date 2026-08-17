import type { ExperimentQueueMessage } from "@velum-labs/routekit-eval-contracts";
import { start } from "workflow/api";

import { handleCallback } from "@/lib/queue";
import { runSandboxJobWorkflow } from "@/workflows/sandbox-job";

export const runtime = "nodejs";

export const POST = handleCallback<ExperimentQueueMessage>(
  async (message, metadata) => {
    await start(runSandboxJobWorkflow, [
      message.jobId,
      `sandbox-queue-${metadata.messageId}`
    ]);
  },
  {
    visibilityTimeoutSeconds: 60,
    retry: (_error, metadata) =>
      metadata.deliveryCount > 5
        ? { acknowledge: true }
        : { afterSeconds: Math.min(600, 2 ** metadata.deliveryCount * 10) }
  }
);
