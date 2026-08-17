import type { ExperimentQueueMessage } from "@velum-labs/routekit-eval-contracts";

import { ExperimentJobDeferredError, processExperimentJob } from "@/lib/execute-job";
import { handleCallback } from "@/lib/queue";

export const runtime = "nodejs";

export const POST = handleCallback<ExperimentQueueMessage>(
  async (message, metadata) => {
    await processExperimentJob(message.jobId, `queue-${metadata.messageId}`);
  },
  {
    visibilityTimeoutSeconds: 600,
    retry: (error, metadata) =>
      error instanceof ExperimentJobDeferredError
        ? { afterSeconds: 30 }
        : metadata.deliveryCount > 5
          ? { acknowledge: true }
          : { afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 5) }
  }
);
