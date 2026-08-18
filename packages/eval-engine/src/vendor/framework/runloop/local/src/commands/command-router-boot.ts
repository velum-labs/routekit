import type { ApiFeatureContext } from "../../../../contracts/author/src/api.ts";
import type { CommandRouter } from "../../../../contracts/author/src/command-dispatch.ts";
import type { FeatureLogger } from "../../../../contracts/author/src/feature-logger.ts";
import type { CommandRegistryShape } from "../../../../engine/registries/src/capability.ts";

import { makeCommandRouter } from "./command-router.ts";

/**
 * The scopes an invoker holds in v1 (RFC 0002 command.md open question
 * "scope grant mechanism"): a command runs with the runtime's own privileges,
 * same as a `schedule`, so the grant set is the union of every scope any
 * registered command declares. The check in `command-router` still runs, but
 * because the grant set is that union, a command can never be rejected for a
 * scope it itself declares — so v1 `scopes` are NOT an access gate on who may
 * run a command. A per-surface or per-user grant policy is the follow-up.
 */
const runtimeGrantedScopes = (
  registry: CommandRegistryShape
): readonly string[] => {
  const scopes = new Set<string>();
  for (const entry of registry.entries) {
    for (const scope of entry.value.scopes ?? []) {
      scopes.add(scope);
    }
  }
  return [...scopes];
};

/**
 * Build the pre-agent {@link CommandRouter} from a boot's command registry, ready
 * to inject onto the `Chat` handle. Returns undefined when no commands are
 * registered so a command-free workspace leaves `Chat.commands` unset and every
 * surface falls through to normal agent handling unchanged.
 */
export const makeCommandRouterFromBoot = (input: {
  readonly registry: CommandRegistryShape;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger?: FeatureLogger | undefined;
  readonly useFor: (featureId: string) => ApiFeatureContext["use"];
}): CommandRouter | undefined => {
  if (input.registry.entries.length === 0) {
    return undefined;
  }
  return makeCommandRouter({
    commands: input.registry.entries,
    cwd: input.cwd,
    env: input.env,
    grantedScopes: runtimeGrantedScopes(input.registry),
    logger: input.logger,
    useFor: input.useFor,
  });
};
