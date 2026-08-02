import { basename } from "node:path";

import { canonicalPath, enumerateExecutables } from "../candidate.js";
import type { DiscoveryContext } from "../types.js";

export type ExternalOwner = {
  kind: "homebrew" | "apt" | "rpm" | "pacman" | "snap" | "nix";
  packageName?: string;
  remediation?: readonly string[];
  hint: string;
};

async function successfulLine(
  context: DiscoveryContext,
  executable: string,
  args: readonly string[]
): Promise<string | undefined> {
  const result = await context.runner(executable, args, context.env, {
    cwd: context.neutralCwd,
    operation: "probe"
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export async function detectExternalOwner(
  executablePath: string,
  context: DiscoveryContext
): Promise<ExternalOwner | undefined> {
  const ownershipPaths = [...new Set([executablePath, canonicalPath(executablePath)])];
  for (const brew of enumerateExecutables("brew", context.pathValue, context.platform)) {
    for (const path of ownershipPaths) {
      const formula = await successfulLine(context, brew, ["which-formula", path]);
      if (formula !== undefined) {
        const name = formula.split(/\s+/).at(-1)!;
        return {
          kind: "homebrew",
          packageName: name,
          remediation: [brew, "upgrade", name],
          hint: `this RouteKit executable is owned by Homebrew; upgrade it with ${brew} upgrade ${name}`
        };
      }
    }
  }

  for (const query of enumerateExecutables("dpkg-query", context.pathValue, context.platform)) {
    for (const path of ownershipPaths) {
      const value = await successfulLine(context, query, ["-S", path]);
      const name = value?.split(":", 1)[0]?.trim();
      if (name) {
        const apt =
          enumerateExecutables("apt-get", context.pathValue, context.platform)[0] ?? "apt-get";
        return {
          kind: "apt",
          packageName: name,
          remediation: ["sudo", apt, "install", "--only-upgrade", name],
          hint: `this RouteKit executable is owned by the Debian package ${name}`
        };
      }
    }
  }

  for (const rpm of enumerateExecutables("rpm", context.pathValue, context.platform)) {
    for (const path of ownershipPaths) {
      const name = await successfulLine(context, rpm, ["-qf", path]);
      if (name) {
        const dnf =
          enumerateExecutables("dnf", context.pathValue, context.platform)[0] ??
          enumerateExecutables("yum", context.pathValue, context.platform)[0] ??
          "dnf";
        return {
          kind: "rpm",
          packageName: name,
          remediation: ["sudo", dnf, "upgrade", name],
          hint: `this RouteKit executable is owned by the RPM package ${name}`
        };
      }
    }
  }

  for (const pacman of enumerateExecutables("pacman", context.pathValue, context.platform)) {
    for (const path of ownershipPaths) {
      const line = await successfulLine(context, pacman, ["-Qo", path]);
      const match = line?.match(/ is owned by ([^\s]+)/);
      if (match?.[1]) {
        return {
          kind: "pacman",
          packageName: match[1],
          remediation: ["sudo", pacman, "-S", match[1]],
          hint: `this RouteKit executable is owned by the pacman package ${match[1]}`
        };
      }
    }
  }

  const snap = enumerateExecutables("snap", context.pathValue, context.platform)[0];
  const snapPath = ownershipPaths.find(
    (path) => path.includes("/snap/") || path.startsWith("/snap/bin/")
  );
  if (snap !== undefined && snapPath !== undefined) {
    const components = snapPath.split("/").filter(Boolean);
    const snapIndex = components.indexOf("snap");
    const name =
      components[snapIndex + 1] === "bin"
        ? basename(snapPath)
        : components[snapIndex + 1];
    if (name !== undefined) {
      const listed = await successfulLine(context, snap, [
        "list",
        name,
        "--unicode=never",
        "--color=never"
      ]);
      if (listed !== undefined) {
        return {
          kind: "snap",
          packageName: name,
          remediation: ["sudo", snap, "refresh", name],
          hint: `this RouteKit executable is owned by the Snap package ${name}`
        };
      }
    }
  }

  const nixPath = ownershipPaths.find((path) => path.includes("/nix/store/"));
  if (nixPath !== undefined) {
    const nixStore = enumerateExecutables("nix-store", context.pathValue, context.platform)[0];
    if (nixStore !== undefined) {
      const owner = await successfulLine(context, nixStore, ["--query", "--deriver", nixPath]);
      if (owner !== undefined) {
        return {
          kind: "nix",
          packageName: owner,
          hint:
            "this RouteKit executable is owned by the Nix store; update the profile or flake that installed it"
        };
      }
    }
  }
  return undefined;
}
