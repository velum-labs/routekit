import { Effect } from "effect";

// Ceiling on the SIGTERM -> SIGKILL escalation. Finite, so no misbehaving
// child can wedge the stream forever.
const KILL_GRACE_MS = 1000;
// Liveness-poll cadence during the grace window, so a well-behaved subtree is
// reaped promptly instead of holding teardown for the full grace.
const REAP_POLL_MS = 50;

const signalProcessGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    globalThis.process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
};

const isProcessGroupAlive = (pid: number): boolean => {
  try {
    globalThis.process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Descendants the child leaves behind (nested harness runs, node, esbuild
// service daemons) stay in its process group after the child itself exits —
// including a clean exit 0, where the spawner's own release does nothing. Sweep
// the group at scope close with SIGTERM -> grace -> SIGKILL so no teardown path
// can leak a subtree (ROUTEKIT_EVAL-472). An empty group fails the first signal with
// ESRCH, so the common no-orphan case skips the grace window entirely; a
// SIGTERM-obeying subtree exits within one poll tick, so only a
// SIGTERM-ignoring subtree pays the full grace before the SIGKILL.
export const reapProcessGroup = Effect.fn("reapProcessGroup")(function* (
  pid: number
) {
  if (globalThis.process.platform === "win32") {
    return;
  }
  if (!signalProcessGroup(pid, "SIGTERM")) {
    return;
  }
  for (let waited = 0; waited < KILL_GRACE_MS; waited += REAP_POLL_MS) {
    yield* Effect.sleep(REAP_POLL_MS);
    if (!isProcessGroupAlive(pid)) {
      return;
    }
  }
  signalProcessGroup(pid, "SIGKILL");
});
