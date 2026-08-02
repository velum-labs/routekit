import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { SelfUpdateInspectionError } from "./diagnostics.js";

type LockMetadata = {
  pid: number;
  contextId: string;
  acquiredAt: string;
  nonce: string;
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockName(contextId: string): string {
  const hash = createHash("sha256").update(contextId).digest("hex").slice(0, 24);
  let uid = "user";
  try {
    uid = String(userInfo().uid);
  } catch {
    // Keep the portable fallback.
  }
  return `${uid}-${hash}.lock`;
}

export function acquireSelfUpdateLock(
  contextId: string,
  root = join(tmpdir(), "routekit-self-update")
): { path: string; release(): void } {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, lockName(contextId));
  const nonce = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex");
  const acquire = (): boolean => {
    try {
      mkdirSync(path, { mode: 0o700 });
      const metadata: LockMetadata = {
        pid: process.pid,
        contextId,
        acquiredAt: new Date().toISOString(),
        nonce
      };
      writeFileSync(join(path, "owner.json"), `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!acquire()) {
    let stale = true;
    try {
      const value = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as {
        pid?: unknown;
      };
      stale = typeof value.pid !== "number" || !processAlive(value.pid);
    } catch {
      stale = true;
    }
    if (stale) {
      rmSync(path, { recursive: true, force: true });
      if (!acquire()) stale = false;
    }
    if (!stale) {
      throw new SelfUpdateInspectionError({
        code: "self_update_locked",
        message: "another RouteKit self-update is already running for this installation",
        diagnostics: [`lock: ${path}`]
      });
    }
  }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      if (!existsSync(path)) return;
      try {
        const current = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as {
          pid?: unknown;
          nonce?: unknown;
        };
        if (current.pid !== process.pid || current.nonce !== nonce) return;
      } catch {
        return;
      }
      rmSync(path, { recursive: true, force: true });
    }
  };
}
