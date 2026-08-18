import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createPresenter, isInteractive } from "@velum-labs/routekit-cli-ui";
import { SERVICE_HOME_MODE } from "@velum-labs/routekit-runtime/service";
import { writeFileAtomic } from "@velum-labs/routekit-runtime/filesystem";
import { runCliEffect } from "./cli-session.js";
import { routekitHome } from "./config.js";
import { fetchLatestRouteKitVersion } from "./install-version.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type UpdateCache = {
  checkedAt: number;
  latest?: string;
};

function cachePath(): string {
  return join(routekitHome(), "update-check.json");
}

function readCache(): UpdateCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<UpdateCache>;
    if (typeof parsed.checkedAt !== "number") return undefined;
    return {
      checkedAt: parsed.checkedAt,
      ...(typeof parsed.latest === "string" ? { latest: parsed.latest } : {})
    };
  } catch {
    return undefined;
  }
}

function writeCache(cache: UpdateCache): void {
  const directory = routekitHome();
  mkdirSync(directory, { recursive: true, mode: SERVICE_HOME_MODE });
  chmodSync(directory, SERVICE_HOME_MODE);
  writeFileAtomic(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  chmodSync(cachePath(), 0o600);
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number(part) || 0);
}

function newer(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) {
      return (left[index] ?? 0) > (right[index] ?? 0);
    }
  }
  return false;
}

export async function notifyIfUpdateAvailable(currentVersion: string): Promise<void> {
  if (process.env.ROUTEKIT_NO_UPDATE_CHECK !== undefined) return;
  if (!isInteractive() || !process.stderr.isTTY) return;
  let cache = readCache();
  if (cache === undefined || Date.now() - cache.checkedAt >= DAY_MS) {
    try {
      const latest = await runCliEffect(fetchLatestRouteKitVersion({ timeoutMs: 1_000 }));
      cache = {
        checkedAt: Date.now(),
        latest
      };
      writeCache(cache);
    } catch {
      // Update checks are best-effort and must never affect a command result.
      return;
    }
  }
  if (cache.latest !== undefined && newer(cache.latest, currentVersion)) {
    createPresenter().note(
      `RouteKit ${cache.latest} is available (current ${currentVersion}); update with routekit self-update`
    );
  }
}
