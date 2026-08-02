export const ROUTEKIT_PACKAGE_NAME = "@velum-labs/routekit";

export type CommandOperation = "probe" | "metadata" | "install";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
};

export type CommandRunOptions = {
  cwd?: string;
  operation?: CommandOperation;
  timeoutMs?: number;
};

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: CommandRunOptions
) => Promise<CommandResult>;

export type CommandInvocation = {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  operation: CommandOperation;
};

export type RouteKitCandidate = {
  path: string;
  entry: string;
  packageRoot: string;
  manifestVersion: string;
  executableVersion: string;
  processExecPath?: string;
  protocol: "self-inspect" | "legacy";
};

type OwnerBase = {
  provenance: "routekit-installer" | "package-manager";
  executable: string;
  packageRoot: string;
  binDirectory: string;
  contextId: string;
};

export type NpmOwner = OwnerBase & {
  kind: "npm";
  prefix: string;
  globalRoot: string;
  receiptPath?: string;
};

export type PnpmOwner = OwnerBase & {
  kind: "pnpm";
  globalBin: string;
  globalRoot: string;
};

export type YarnOwner = OwnerBase & {
  kind: "yarn";
  globalBin: string;
  globalRoot: string;
};

export type BunOwner = OwnerBase & {
  kind: "bun";
  globalBin: string;
  globalRoot: string;
};

export type VoltaOwner = OwnerBase & {
  kind: "volta";
  voltaHome: string;
};

export type InstallOwner = NpmOwner | PnpmOwner | YarnOwner | BunOwner | VoltaOwner;
/** Backward-compatible type name retained for existing imports. */
export type PackageOwner = InstallOwner;

export type InstallationInspection = {
  originalPath: string;
  executing: RouteKitCandidate;
  pathCandidates: RouteKitCandidate[];
  owner: InstallOwner;
  command: readonly string[];
  diagnostics: readonly string[];
};

export type InspectOptions = {
  path?: string;
  env?: NodeJS.ProcessEnv;
  executingEntry?: string;
  processExecPath?: string;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
};

export type InstallVersionResolver = (requestedVersion: string) => Promise<string>;

export type SelfUpdateOptions = InspectOptions & {
  resolveVersion?: InstallVersionResolver;
  lockRoot?: string;
};

export type SelfUpdateResult = {
  action: "planned" | "updated" | "skipped";
  from: string;
  to: string;
  version: string;
  targetVersion: string;
  owner: InstallOwner;
  command: readonly string[];
  diagnostics: readonly string[];
};

export type DiscoveryContext = {
  packageRoot: string;
  pathValue: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  processExecPath: string;
  runner: CommandRunner;
  neutralCwd: string;
  diagnostics: string[];
};

export type SelfUpdateAdapter<Owner extends InstallOwner = InstallOwner> = {
  kind: Owner["kind"];
  detect(context: DiscoveryContext): Promise<Owner[]>;
  buildUpdate(owner: Owner, targetVersion: string, context: DiscoveryContext): CommandInvocation;
  verifyOwner(
    owner: Owner,
    fresh: RouteKitCandidate,
    context: DiscoveryContext
  ): Promise<Owner | undefined>;
  resolveTarget?(
    owner: Owner,
    requestedVersion: string,
    context: DiscoveryContext
  ): Promise<string | undefined>;
};
