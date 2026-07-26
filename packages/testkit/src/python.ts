/**
 * How the RouteKit testkit reaches the Python provider simulator.
 *
 * The simulator itself still lives in handoffkit (`python/fusionkit-testkit`)
 * until that package is extracted. Override with `ROUTEKIT_SIM_ROOT` (preferred)
 * or `HANDOFFKIT_ROOT` pointing at a sibling handoffkit checkout.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This monorepo root (`packages/testkit` → root). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Root that owns the Python `fusionkit-testkit` / `fusionkit-sim` entrypoint. */
export function simRoot(): string {
  for (const key of ["ROUTEKIT_SIM_ROOT", "HANDOFFKIT_ROOT", "FUSIONKIT_TESTKIT_ROOT"]) {
    const override = process.env[key];
    if (override !== undefined && override.length > 0) return override;
  }
  const sibling = resolve(repoRoot(), "..", "handoffkit");
  if (existsSync(join(sibling, "python", "fusionkit-testkit"))) return sibling;
  return repoRoot();
}

export type StackTooling =
  | { available: true }
  | { available: false; reason: string };

export function detectStackTooling(): StackTooling {
  if (process.env.ROUTEKIT_E2E_STACK === "0" || process.env.FUSIONKIT_E2E_STACK === "0") {
    return { available: false, reason: "disabled via ROUTEKIT_E2E_STACK=0" };
  }
  const root = simRoot();
  if (!existsSync(join(root, "python", "fusionkit-testkit"))) {
    return {
      available: false,
      reason: `Python simulator not found (set ROUTEKIT_SIM_ROOT / HANDOFFKIT_ROOT; looked in ${root})`
    };
  }
  const probe = spawnSync("uv", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    return { available: false, reason: "uv is not on PATH (the Python workspace tooling)" };
  }
  return { available: true };
}

export function stackToolingSkip(): false | string {
  const tooling = detectStackTooling();
  return tooling.available ? false : `stack tooling unavailable: ${tooling.reason}`;
}

export function uvRunArgv(pkg: string, entrypoint: string, args: readonly string[]): {
  command: string;
  args: string[];
  cwd: string;
} {
  const root = simRoot();
  const installed = join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? `${entrypoint}.exe` : entrypoint
  );
  if (existsSync(installed)) {
    return { command: installed, args: [...args], cwd: root };
  }
  return {
    command: "uv",
    args: ["run", "--package", pkg, entrypoint, ...args],
    cwd: root
  };
}
