import { detect } from "package-manager-detector/detect";
import { bunAdapter } from "./adapters/bun.js";
import { detectExternalOwner } from "./adapters/external.js";
import { npmAdapter } from "./adapters/npm.js";
import { pnpmAdapter } from "./adapters/pnpm.js";
import { voltaAdapter } from "./adapters/volta.js";
import { yarnAdapter } from "./adapters/yarn.js";
import { canonicalPath } from "./candidate.js";
import { SelfUpdateInspectionError } from "./diagnostics.js";
import { packageRootProject } from "./receipt.js";
import type { DiscoveryContext, InstallOwner, SelfUpdateAdapter } from "./types.js";

export const SELF_UPDATE_ADAPTERS: readonly SelfUpdateAdapter[] = [
  npmAdapter,
  pnpmAdapter,
  yarnAdapter,
  bunAdapter,
  voltaAdapter
];

export function adapterFor(owner: InstallOwner): SelfUpdateAdapter {
  return SELF_UPDATE_ADAPTERS.find((adapter) => adapter.kind === owner.kind)!;
}

export async function detectOwners(context: DiscoveryContext): Promise<InstallOwner[]> {
  const found = (
    await Promise.all(SELF_UPDATE_ADAPTERS.map((adapter) => adapter.detect(context)))
  ).flat();
  const owners: InstallOwner[] = [];
  for (const owner of found) {
    if (!owners.some((candidate) => candidate.contextId === owner.contextId)) owners.push(owner);
  }
  return owners;
}

function isEphemeralPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return [
    "/_npx/",
    "/.npm/_npx/",
    "/pnpm/dlx/",
    "/.cache/pnpm/dlx/",
    "/yarn/dlx/",
    "/xfs-",
    "/.bun/install/cache/"
  ].some((marker) => normalized.includes(marker));
}

function isKnownGlobalPackagePath(packageRoot: string): boolean {
  const normalized = canonicalPath(packageRoot).replaceAll("\\", "/").toLowerCase();
  return [
    "/lib/node_modules/@velum-labs/routekit",
    "/global/node_modules/@velum-labs/routekit",
    "/global/v",
    "/.config/yarn/global/node_modules/",
    "/.bun/install/global/node_modules/",
    "/.volta/tools/image/packages/",
    "/pnpm/store/"
  ].some((marker) => normalized.includes(marker));
}

function isLocalPackage(packageRoot: string): boolean {
  if (isKnownGlobalPackagePath(packageRoot)) return false;
  const project = packageRootProject(packageRoot);
  return project !== undefined;
}

export async function throwUnownedInstallation(
  executablePath: string,
  context: DiscoveryContext,
  diagnostics: readonly string[]
): Promise<never> {
  const external = await detectExternalOwner(executablePath, context);
  if (external !== undefined) {
    throw new SelfUpdateInspectionError({
      code: "self_update_external_owner",
      message: "the executing RouteKit CLI is owned by an external package manager",
      diagnostics: [...diagnostics, `external owner: ${external.kind}`],
      ...(external.remediation !== undefined ? { remediation: external.remediation } : {}),
      hint: external.hint
    });
  }

  if (isEphemeralPath(executablePath) || isEphemeralPath(context.packageRoot)) {
    throw new SelfUpdateInspectionError({
      code: "self_update_ephemeral_install",
      message: "the executing RouteKit CLI is an ephemeral package-manager execution",
      diagnostics,
      hint: "rerun it through npx, pnpm dlx, Yarn DLX, or bunx instead of self-updating"
    });
  }

  const project = packageRootProject(context.packageRoot);
  if (project !== undefined) {
    const detected = await detect({
      cwd: project,
      stopDir: project,
      strategies: ["install-metadata", "lockfile", "packageManager-field", "devEngines-field"]
    });
    if (detected?.agent === "yarn@berry") {
      throw new SelfUpdateInspectionError({
        code: "self_update_yarn_berry",
        message: "Yarn Berry does not provide a global installation model for RouteKit",
        diagnostics: [
          ...diagnostics,
          `project root: ${project}`,
          "detected project package manager: yarn@berry"
        ],
        hint: "update the project dependency or install RouteKit with the public installer"
      });
    }
    if (detected !== null || isLocalPackage(context.packageRoot)) {
      throw new SelfUpdateInspectionError({
        code: "self_update_local_install",
        message: "the executing RouteKit CLI belongs to a local or linked project installation",
        diagnostics: [
          ...diagnostics,
          `project root: ${project}`,
          `detected project package manager: ${detected?.agent ?? "unknown"}`
        ],
        hint: "update the RouteKit dependency from the owning project"
      });
    }
  }

  throw new SelfUpdateInspectionError({
    code: "self_update_owner_unknown",
    message: "could not identify the installer that owns the executing RouteKit CLI",
    diagnostics,
    hint: "reinstall RouteKit with the public installer or update it with the package manager that created this executable"
  });
}

export function ownerDiagnostics(owner: InstallOwner, index: number): string {
  const details = [
    `package manager ${index + 1}: kind=${owner.kind}`,
    `provenance=${owner.provenance}`,
    `executable=${owner.executable}`,
    `package=${owner.packageRoot}`,
    `bin=${owner.binDirectory}`,
    `context=${owner.contextId}`
  ];
  if (owner.kind === "npm") details.push(`prefix=${owner.prefix}`, `root=${owner.globalRoot}`);
  if (owner.kind === "pnpm" || owner.kind === "yarn" || owner.kind === "bun")
    details.push(`root=${owner.globalRoot}`);
  if (owner.kind === "volta") details.push(`home=${owner.voltaHome}`);
  return details.join(" ");
}
