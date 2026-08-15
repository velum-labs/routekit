import { dirname } from "node:path";

import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { resolveInstallVersion } from "../install-version.js";
import {
  enumerateExecutables,
  inspectCandidate,
  packageRootFromEntry,
  samePath,
  shimTarget
} from "./candidate.js";
import { diagnosticTail, SelfUpdateInspectionError } from "./diagnostics.js";
import {
  adapterFor,
  detectOwners,
  ownerDiagnostics,
  throwUnownedInstallation
} from "./discovery.js";
import { acquireSelfUpdateLock } from "./lock.js";
import { type InstallerReceipt, isPrivateInstallerNpm, writeInstallerReceipt } from "./receipt.js";
import { defaultRunner, neutralSelfUpdateCwd } from "./runner.js";
import { resolveSelfUpdateTarget } from "./target-version.js";
import type {
  CommandInvocation,
  DiscoveryContext,
  InspectOptions,
  InstallationInspection,
  InstallOwner,
  SelfUpdateAdapter,
  SelfUpdateOptions,
  SelfUpdateResult
} from "./types.js";

function buildUpdate(
  owner: InstallOwner,
  targetVersion: string,
  context: DiscoveryContext
): CommandInvocation {
  const adapter = adapterFor(owner) as SelfUpdateAdapter<InstallOwner>;
  return adapter.buildUpdate(owner, targetVersion, context);
}

function remediationCommandForOwner(
  owner: InstallOwner,
  version: string,
  context: DiscoveryContext
): readonly string[] {
  const invocation = buildUpdate(owner, version, context);
  return [invocation.executable, ...invocation.args];
}

export function remediationCommand(
  owner:
    | InstallOwner
    | {
        kind: "npm";
        executable: string;
        packageRoot: string;
        prefix: string;
      }
    | {
        kind: "pnpm";
        executable: string;
        packageRoot: string;
        globalBin?: string;
      }
    | undefined,
  version: string
): string[] | undefined {
  if (owner === undefined) return undefined;
  if (!("contextId" in owner)) {
    const specifier = `@velum-labs/routekit@${version}`;
    return owner.kind === "npm"
      ? [
          owner.executable,
          "install",
          "-g",
          "--force",
          "--no-audit",
          "--no-fund",
          "--prefix",
          owner.prefix,
          specifier
        ]
      : [owner.executable, "add", "-g", specifier, "--config.minimum-release-age=0"];
  }
  // A package manager must inherit registry, proxy, auth, HOME, and version-manager state.
  // env-spread-allowed: trusted self-update package-manager child
  const env = { ...process.env };
  const context: DiscoveryContext = {
    packageRoot: owner.packageRoot,
    pathValue: env.PATH ?? "",
    platform: process.platform,
    env,
    processExecPath: process.execPath,
    runner: defaultRunner,
    neutralCwd: neutralSelfUpdateCwd,
    diagnostics: []
  };
  return [...remediationCommandForOwner(owner, version, context)];
}

function executingPackageRoot(entry: string | undefined): string | undefined {
  if (entry === undefined) return undefined;
  try {
    return packageRootFromEntry(shimTarget(entry));
  } catch {
    return undefined;
  }
}

function contextFor(
  packageRoot: string,
  originalPath: string,
  options: InspectOptions,
  diagnostics: string[]
): DiscoveryContext {
  // Ownership probes need the executing CLI's package-manager and user configuration.
  // env-spread-allowed: trusted self-update package-manager probe
  const env = { ...process.env, ...options.env, PATH: originalPath };
  return {
    packageRoot,
    pathValue: originalPath,
    platform: options.platform ?? process.platform,
    env,
    processExecPath: options.processExecPath ?? process.execPath,
    runner: options.runner ?? defaultRunner,
    neutralCwd: neutralSelfUpdateCwd,
    diagnostics
  };
}

export async function inspectSelfUpdateInstallation(
  version: string,
  options: InspectOptions = {}
): Promise<InstallationInspection> {
  const originalPath = options.path ?? options.env?.PATH ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new SelfUpdateInspectionError({
      code: "self_update_platform_unsupported",
      message: "RouteKit self-update currently supports macOS and Linux",
      diagnostics: [`platform: ${platform}`]
    });
  }
  // Candidate inspection and native inventory need the original login environment.
  // env-spread-allowed: trusted self-update candidate and manager probes
  const env = { ...process.env, ...options.env, PATH: originalPath };
  const runner = options.runner ?? defaultRunner;
  const candidatePaths = enumerateExecutables("routekit", originalPath, platform);
  const candidates = (
    await Promise.all(candidatePaths.map((path) => inspectCandidate(path, env, runner)))
  ).filter((candidate) => candidate !== undefined);
  const firstCandidate =
    candidatePaths[0] === undefined
      ? undefined
      : candidates.find((candidate) => samePath(candidate.path, candidatePaths[0]!));
  const executingEntry = options.executingEntry ?? process.argv[1];
  const executingRoot =
    executingPackageRoot(executingEntry) ??
    candidates.find((candidate) => samePath(candidate.path, executingEntry ?? ""))?.packageRoot;
  const diagnostics = [
    `PATH RouteKit executables: ${candidatePaths.length}`,
    ...candidatePaths.map((path, index) => `PATH executable ${index + 1}: ${path}`),
    `PATH RouteKit candidates: ${candidates.length}`,
    ...candidates.map(
      (candidate, index) =>
        `PATH candidate ${index + 1}: executable=${candidate.path} entry=${candidate.entry} package=${candidate.packageRoot} manifest=${candidate.manifestVersion} reported=${candidate.executableVersion} protocol=${candidate.protocol}`
    ),
    `executing entry: ${executingEntry ?? "unresolved"}`,
    `executing package: ${executingRoot ?? "unresolved"}`
  ];
  const discovery =
    executingRoot === undefined
      ? undefined
      : contextFor(executingRoot, originalPath, options, diagnostics);
  const owners = discovery === undefined ? [] : await detectOwners(discovery);
  diagnostics.push(`matching package managers: ${owners.length}`, ...owners.map(ownerDiagnostics));
  const ownerHint = owners.length === 1 ? owners[0] : undefined;

  if (executingRoot === undefined) {
    throw new SelfUpdateInspectionError({
      code: "self_update_executing_package_unresolved",
      message: "the executing RouteKit package could not be resolved",
      diagnostics
    });
  }
  if (!candidates.some((candidate) => samePath(candidate.packageRoot, executingRoot))) {
    throw new SelfUpdateInspectionError({
      code: "self_update_executing_not_on_path",
      message:
        "the executing RouteKit CLI does not match a RouteKit executable on the original PATH",
      diagnostics,
      ...(ownerHint !== undefined && discovery !== undefined
        ? { remediation: remediationCommandForOwner(ownerHint, version, discovery) }
        : {})
    });
  }
  if (firstCandidate === undefined) {
    throw new SelfUpdateInspectionError({
      code: "self_update_first_path_uninspectable",
      message: "the first RouteKit executable on PATH could not be inspected",
      diagnostics,
      ...(ownerHint !== undefined && discovery !== undefined
        ? { remediation: remediationCommandForOwner(ownerHint, version, discovery) }
        : {})
    });
  }
  if (!samePath(firstCandidate.packageRoot, executingRoot)) {
    throw new SelfUpdateInspectionError({
      code: "self_update_path_collision",
      message: "the first RouteKit executable on PATH does not resolve to the executing package",
      diagnostics,
      ...(ownerHint !== undefined && discovery !== undefined
        ? { remediation: remediationCommandForOwner(ownerHint, version, discovery) }
        : {})
    });
  }
  if (firstCandidate.manifestVersion !== firstCandidate.executableVersion) {
    throw new SelfUpdateInspectionError({
      code: "self_update_version_mismatch",
      message: "the executing RouteKit package manifest and executable versions do not match",
      diagnostics,
      ...(ownerHint !== undefined && discovery !== undefined
        ? { remediation: remediationCommandForOwner(ownerHint, version, discovery) }
        : {})
    });
  }
  if (owners.length === 0) {
    await throwUnownedInstallation(firstCandidate.path, discovery!, diagnostics);
  }
  if (owners.length > 1) {
    throw new SelfUpdateInspectionError({
      code: "self_update_owner_ambiguous",
      message: "multiple package-manager contexts claim the executing RouteKit CLI",
      diagnostics
    });
  }
  const owner = owners[0]!;
  const command = remediationCommandForOwner(owner, version, discovery!);
  return {
    originalPath,
    executing: firstCandidate,
    pathCandidates: candidates,
    owner,
    command,
    diagnostics
  };
}

function refreshInstallerReceipt(
  owner: InstallOwner,
  freshPath: string,
  freshProcessExecPath: string | undefined,
  env: NodeJS.ProcessEnv
): void {
  if (owner.kind !== "npm" || owner.provenance !== "routekit-installer") return;
  const privateMode = isPrivateInstallerNpm(owner.executable, owner.prefix, env);
  const receipt: InstallerReceipt = {
    schemaVersion: 1,
    provenance: "routekit-installer",
    manager: "npm",
    packageName: "@velum-labs/routekit",
    prefix: owner.prefix,
    npmExecutable: owner.executable,
    nodeExecutable: freshProcessExecPath ?? process.execPath,
    routekitExecutable: freshPath,
    installMode: privateMode ? "private" : "system"
  };
  writeInstallerReceipt(receipt);
}

async function inspectFreshOwner(
  owner: InstallOwner,
  originalPath: string,
  options: InspectOptions,
  env: NodeJS.ProcessEnv,
  runner: DiscoveryContext["runner"]
): Promise<{
  fresh?: Awaited<ReturnType<typeof inspectCandidate>>;
  freshOwner?: InstallOwner;
  owners: InstallOwner[];
}> {
  const firstPath = enumerateExecutables(
    "routekit",
    originalPath,
    options.platform ?? process.platform
  )[0];
  const fresh =
    firstPath === undefined ? undefined : await inspectCandidate(firstPath, env, runner);
  if (fresh === undefined) return { fresh, owners: [] };
  const freshContext = contextFor(fresh.packageRoot, originalPath, options, []);
  const owners = await detectOwners(freshContext);
  const adapter = adapterFor(owner) as SelfUpdateAdapter<InstallOwner>;
  const freshOwner = await adapter.verifyOwner(owner, fresh, freshContext);
  return { fresh, freshOwner, owners };
}

export async function performSelfUpdate(
  version: string,
  dryRun: boolean,
  options: SelfUpdateOptions = {}
): Promise<SelfUpdateResult> {
  const inspection = await inspectSelfUpdateInstallation(version, options);
  const discovery = contextFor(inspection.executing.packageRoot, inspection.originalPath, options, [
    ...inspection.diagnostics
  ]);
  const targetVersion = await resolveSelfUpdateTarget(
    inspection.owner,
    version,
    discovery,
    options.resolveVersion ?? ((requested) => runRouteKitEffect(resolveInstallVersion(requested)))
  );
  const invocation = buildUpdate(inspection.owner, targetVersion, discovery);
  const command = [invocation.executable, ...invocation.args];
  if (inspection.executing.executableVersion === targetVersion) {
    return {
      action: "skipped",
      from: inspection.executing.executableVersion,
      to: inspection.executing.executableVersion,
      version,
      targetVersion,
      owner: inspection.owner,
      command,
      diagnostics: inspection.diagnostics
    };
  }
  if (dryRun) {
    return {
      action: "planned",
      from: inspection.executing.executableVersion,
      to: inspection.executing.executableVersion,
      version,
      targetVersion,
      owner: inspection.owner,
      command,
      diagnostics: inspection.diagnostics
    };
  }

  const lock = acquireSelfUpdateLock(inspection.owner.contextId, options.lockRoot);
  try {
    const before = await inspectFreshOwner(
      inspection.owner,
      inspection.originalPath,
      options,
      invocation.env,
      discovery.runner
    );
    if (
      before.fresh !== undefined &&
      before.freshOwner !== undefined &&
      before.fresh.manifestVersion === targetVersion &&
      before.fresh.executableVersion === targetVersion
    ) {
      return {
        action: "skipped",
        from: before.fresh.executableVersion,
        to: before.fresh.executableVersion,
        version,
        targetVersion,
        owner: before.freshOwner,
        command,
        diagnostics: inspection.diagnostics
      };
    }
    if (before.fresh === undefined || before.freshOwner === undefined) {
      throw new SelfUpdateInspectionError({
        code: "self_update_owner_changed",
        message: "the RouteKit installation changed before the update lock was acquired",
        diagnostics: [
          ...inspection.diagnostics,
          `fresh package: ${before.fresh?.packageRoot ?? "unresolved"}`,
          `fresh matching package managers: ${before.owners.length}`,
          ...before.owners.map(ownerDiagnostics)
        ]
      });
    }

    const result = await discovery.runner(invocation.executable, invocation.args, invocation.env, {
      cwd: invocation.cwd,
      operation: invocation.operation
    });
    if (result.exitCode !== 0) {
      throw new SelfUpdateInspectionError({
        code: "self_update_command_failed",
        message: `the ${inspection.owner.kind} update command failed with exit ${result.exitCode}`,
        remediation: command,
        diagnostics: [
          ...inspection.diagnostics,
          ...(result.timedOut === true ? ["the update command timed out"] : []),
          ...diagnosticTail(result.stderr || result.stdout, invocation.env).map(
            (line) => `${result.stderr ? "stderr" : "stdout"}: ${line}`
          )
        ]
      });
    }

    const after = await inspectFreshOwner(
      inspection.owner,
      inspection.originalPath,
      options,
      invocation.env,
      discovery.runner
    );
    if (
      after.fresh === undefined ||
      after.freshOwner === undefined ||
      after.owners.length !== 1 ||
      after.fresh.manifestVersion !== targetVersion ||
      after.fresh.executableVersion !== targetVersion
    ) {
      throw new SelfUpdateInspectionError({
        code: "self_update_verification_failed",
        message:
          "RouteKit update verification failed: the owner, manifest, and first PATH executable do not agree",
        remediation: command,
        diagnostics: [
          ...inspection.diagnostics,
          `fresh package: ${after.fresh?.packageRoot ?? "unresolved"}`,
          `fresh matching package managers: ${after.owners.length}`,
          ...after.owners.map(ownerDiagnostics),
          `fresh manifest version: ${after.fresh?.manifestVersion ?? "unresolved"}`,
          `first PATH executable version: ${after.fresh?.executableVersion ?? "unresolved"}`
        ]
      });
    }
    refreshInstallerReceipt(
      inspection.owner,
      after.fresh.path,
      after.fresh.processExecPath,
      invocation.env
    );
    return {
      action: "updated",
      from: inspection.executing.executableVersion,
      to: after.fresh.executableVersion,
      version,
      targetVersion,
      owner: after.freshOwner,
      command,
      diagnostics: inspection.diagnostics
    };
  } finally {
    lock.release();
  }
}
