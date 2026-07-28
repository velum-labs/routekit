import type { ServerResponse } from "node:http";

/**
 * Wait for backpressure to clear or the client to disconnect, removing the
 * listener for whichever event loses the race.
 */
export function waitForDrainOrClose(
  res: ServerResponse
): Promise<"drain" | "close"> {
  if (res.destroyed) return Promise.resolve("close");
  return new Promise((resolve) => {
    const settle = (event: "drain" | "close"): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(event);
    };
    const onDrain = (): void => settle("drain");
    const onClose = (): void => settle("close");
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}
