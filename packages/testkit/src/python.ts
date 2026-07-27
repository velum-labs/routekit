/**
 * How the RouteKit testkit reaches the provider simulator (`routekit-sim`).
 *
 * Override the executable with `ROUTEKIT_SIM_COMMAND` or point `ROUTEKIT_SIM_ROOT`
 * at a checkout that installs `routekit-sim` under `.venv/bin` or `bin/`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIM_EXECUTABLE = ["routekit", "sim"].join("-");

/** This monorepo root (`packages/testkit` → root). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export type RoutekitSimRunner = {
  command: string;
  args: string[];
  cwd?: string;
};

function simBinaryName(): string {
  return process.platform === "win32" ? `${SIM_EXECUTABLE}.exe` : SIM_EXECUTABLE;
}

function simUnderRoot(root: string): string | undefined {
  const binDir = process.platform === "win32" ? "Scripts" : "bin";
  const candidates = [
    join(root, ".venv", binDir, simBinaryName()),
    join(root, "bin", simBinaryName())
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Resolve the `routekit-sim` executable used by cross-stack tests. */
export function resolveRoutekitSim(): RoutekitSimRunner | undefined {
  const override = process.env.ROUTEKIT_SIM_COMMAND;
  if (override !== undefined && override.trim().length > 0) {
    const parts = override.trim().split(/\s+/);
    const [command, ...args] = parts;
    if (command === undefined || command.length === 0) return undefined;
    return { command, args };
  }

  const root = process.env.ROUTEKIT_SIM_ROOT;
  if (root !== undefined && root.length > 0) {
    const installed = simUnderRoot(root);
    if (installed !== undefined) {
      return { command: installed, args: [], cwd: root };
    }
  }

  const probe = spawnSync(SIM_EXECUTABLE, ["--version"], { encoding: "utf8" });
  if (probe.error === undefined && probe.status === 0) {
    return { command: SIM_EXECUTABLE, args: [] };
  }
  return undefined;
}

export type StackTooling =
  | { available: true; runner: RoutekitSimRunner }
  | { available: false; reason: string };

export function detectStackTooling(): StackTooling {
  if (process.env.ROUTEKIT_E2E_STACK === "0") {
    return { available: false, reason: "disabled via ROUTEKIT_E2E_STACK=0" };
  }
  const runner = resolveRoutekitSim();
  if (runner === undefined) {
    return {
      available: false,
      reason:
        `${SIM_EXECUTABLE} not found (install on PATH, or set ROUTEKIT_SIM_COMMAND / ROUTEKIT_SIM_ROOT)`
    };
  }
  return { available: true, runner };
}

export function stackToolingSkip(): false | string {
  const tooling = detectStackTooling();
  return tooling.available ? false : `stack tooling unavailable: ${tooling.reason}`;
}
