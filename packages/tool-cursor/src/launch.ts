import { cursorModelName } from "@velum-labs/routekit-contracts";
import { normalizeApiBaseUrl } from "@velum-labs/routekit-runtime";
import type { ToolLaunchContext } from "@velum-labs/routekit-tools";

import { scaffoldCursorSubagents } from "./subagents.js";

/** Base URL for Cursor's "Override OpenAI Base URL" setting. */
export function cursorByokBaseUrl(gatewayUrl: string): string {
  return `${normalizeApiBaseUrl(gatewayUrl)}/cursor`;
}

export function cursorInstructions(
  gatewayUrl: string,
  model: string,
  apiKey?: string
): string {
  // Cursor routes BYOK by model-name prefix (`claude-*` → Anthropic,
  // `gemini-*` → Google). The gateway's /v1/cursor mirror namespaces every
  // id under `routekit/` so the pasted name always uses the OpenAI key +
  // base-URL override.
  return [
    "In Cursor Settings -> Models, enable Override OpenAI Base URL and set:",
    `  Override OpenAI Base URL : ${cursorByokBaseUrl(gatewayUrl)}`,
    `  Model name               : ${cursorModelName(model)}`,
    `  OpenAI API Key           : ${apiKey ?? "routekit-local"}`,
    "Names are namespaced under routekit/ so Cursor does not route them to Anthropic/Google keys."
  ].join("\n");
}

/**
 * Print the endpoint Cursor must be pointed at, then return.
 *
 * Unlike the other tools RouteKit launches, there is no child process to
 * supervise: Cursor is configured once in its own settings and connects from
 * its own process against a gateway this command does not own.
 */
export async function launchCursor(ctx: ToolLaunchContext): Promise<number> {
  const profiles = ctx.spec.agentProfiles ?? [];
  if (profiles.length > 0) {
    scaffoldCursorSubagents(ctx.spec.cwd ?? process.cwd(), profiles, ctx.log);
  }
  ctx.log(
    cursorInstructions(
      ctx.spec.publicUrl ?? ctx.spec.gatewayUrl,
      ctx.spec.defaultModel,
      ctx.spec.auth?.token
    )
  );
  ctx.log("The gateway keeps serving this endpoint; Cursor connects on its own.");
  return 0;
}
