import type { Server } from "node:net";
import { createServer } from "node:net";

const recentlyReserved = new Map<number, NodeJS.Timeout>();
const RESERVATION_MS = 5000;

function reserve(port: number): void {
  const existing = recentlyReserved.get(port);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => recentlyReserved.delete(port), RESERVATION_MS);
  timer.unref();
  recentlyReserved.set(port, timer);
}

/**
 * A held ephemeral port: the loopback listener stays open (so nothing else can
 * grab the port) until the caller `release()`s it — ideally immediately before
 * spawning the process that will bind it, which closes the classic
 * probe-then-close race where a returned port is stolen in the gap. The
 * `server` is exposed so a Node-side caller can adopt the already-bound
 * listener instead of releasing and re-binding.
 */
export type ReservedPort = {
  port: number;
  server: Server;
  release: () => Promise<void>;
};

/**
 * Bind (and hold) a free loopback port. Prefer this over {@link freePort} at
 * any bind site that can race: hold the reservation while preparing the child,
 * then `release()` right before the child binds.
 */
export async function reservePort(): Promise<ReservedPort> {
  for (let attempt = 0; ; attempt += 1) {
    const server = createServer();
    server.unref();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    if (recentlyReserved.has(port) && attempt < 20) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      continue;
    }
    reserve(port);
    let released = false;
    const release = (): Promise<void> =>
      new Promise((resolve) => {
        if (released) {
          resolve();
          return;
        }
        released = true;
        server.close(() => resolve());
      });
    return { port, server, release };
  }
}

export async function freePort(): Promise<number> {
  const reserved = await reservePort();
  await reserved.release();
  return reserved.port;
}
