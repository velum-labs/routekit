import { DuplicateMessageError, QueueClient } from "@vercel/queue";

const client = new QueueClient({
  region: process.env.VERCEL_REGION ?? "iad1"
});

export const { handleCallback, send } = client;
export { DuplicateMessageError };
