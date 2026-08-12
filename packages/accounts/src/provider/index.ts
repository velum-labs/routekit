import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { anthropicProvider } from "./anthropic.js";
import { codexProvider } from "./codex.js";
export * from "./shared.js";
export function subscriptionProvider(mode: "claude-code"): import("./shared.js").SubscriptionProvider<"claude-code">;
export function subscriptionProvider(mode: "codex"): import("./shared.js").SubscriptionProvider<"codex">;
export function subscriptionProvider(mode: SubscriptionMode): import("./shared.js").SubscriptionProvider;
export function subscriptionProvider(mode: SubscriptionMode): import("./shared.js").SubscriptionProvider {
  switch (mode) { case "claude-code": return anthropicProvider(); case "codex": return codexProvider(); default: { const unreachable: never = mode; throw new Error(`unsupported subscription mode: ${String(unreachable)}`); } }
}
