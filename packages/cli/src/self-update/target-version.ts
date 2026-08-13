import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { isExactInstallVersion, resolveInstallVersion } from "../install-version.js";
import { diagnosticTail, SelfUpdateInspectionError } from "./diagnostics.js";
import { adapterFor } from "./discovery.js";
import type { DiscoveryContext, InstallOwner } from "./types.js";

function parsedVersion(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "string" && isExactInstallVersion(value)) return value;
      if (typeof value === "object" && value !== null) {
        const version = Reflect.get(value, "version");
        if (typeof version === "string" && isExactInstallVersion(version)) return version;
        const data = Reflect.get(value, "data");
        if (typeof data === "string" && isExactInstallVersion(data)) return data;
      }
    } catch {
      const match = line.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
      if (match?.[0] !== undefined && isExactInstallVersion(match[0])) return match[0];
    }
  }
  return undefined;
}

function metadataArgs(owner: InstallOwner): readonly string[] | undefined {
  const specifier = "@velum-labs/routekit@latest";
  if (owner.kind === "npm" || owner.kind === "pnpm")
    return ["view", specifier, "version", "--json"];
  if (owner.kind === "yarn") return ["info", specifier, "version", "--json"];
  if (owner.kind === "bun") return ["pm", "view", specifier, "version"];
  return undefined;
}

export async function resolveSelfUpdateTarget(
  owner: InstallOwner,
  requestedVersion: string,
  context: DiscoveryContext,
  fallback = (requested: string) => runRouteKitEffect(resolveInstallVersion(requested))
): Promise<string> {
  if (isExactInstallVersion(requestedVersion)) return requestedVersion;
  if (requestedVersion !== "latest") {
    throw new SelfUpdateInspectionError({
      code: "self_update_invalid_version",
      message: "self-update requires an exact semantic version or latest",
      diagnostics: [`requested version: ${requestedVersion}`]
    });
  }
  const adapter = adapterFor(owner);
  const custom = await adapter.resolveTarget?.(owner as never, requestedVersion, context);
  if (custom !== undefined) {
    if (isExactInstallVersion(custom)) return custom;
    throw new SelfUpdateInspectionError({
      code: "self_update_invalid_metadata",
      message: `${owner.kind} returned an invalid RouteKit release version`,
      diagnostics: [`resolved value: ${custom}`]
    });
  }
  const args = metadataArgs(owner);
  if (args !== undefined) {
    const result = await context.runner(owner.executable, args, context.env, {
      cwd: context.neutralCwd,
      operation: "metadata"
    });
    if (result.exitCode === 0) {
      const version = parsedVersion(result.stdout);
      if (version !== undefined) return version;
    }
    throw new SelfUpdateInspectionError({
      code:
        result.timedOut === true ? "self_update_metadata_timeout" : "self_update_metadata_failed",
      message: `${owner.kind} could not resolve the latest RouteKit release`,
      diagnostics: [
        ...(result.timedOut === true ? ["the metadata query timed out"] : []),
        ...diagnosticTail(result.stderr || result.stdout, context.env).map(
          (line) => `metadata: ${line}`
        )
      ]
    });
  }
  const resolved = await fallback(requestedVersion);
  if (isExactInstallVersion(resolved)) return resolved;
  throw new SelfUpdateInspectionError({
    code: "self_update_invalid_metadata",
    message: "the RouteKit registry returned an invalid release version",
    diagnostics: [`resolved value: ${resolved}`]
  });
}
