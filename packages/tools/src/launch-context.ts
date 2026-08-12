import { ResourceScope } from "@velum-labs/routekit-runtime/lifecycle";

import type { ToolLaunchContext, ToolLaunchSpec } from "./types.js";

export type CreateToolLaunchContextInput = {
  spec: ToolLaunchSpec;
  log: ToolLaunchContext["log"];
  prepareForPassthrough: ToolLaunchContext["prepareForPassthrough"];
  registerPort: ToolLaunchContext["registerPort"];
  unregisterPort: ToolLaunchContext["unregisterPort"];
};

export type ToolLaunchContextHandle = {
  context: ToolLaunchContext;
  dispose(): Promise<void>;
};

/** Pair host lifecycle services with a launch spec and one owned resource scope. */
export function createToolLaunchContext(
  input: CreateToolLaunchContextInput
): ToolLaunchContextHandle {
  const resources = new ResourceScope();
  return {
    context: {
      spec: input.spec,
      log: input.log,
      prepareForPassthrough: input.prepareForPassthrough,
      registerPort: input.registerPort,
      unregisterPort: input.unregisterPort,
      registerDisposer: (dispose) => resources.defer(dispose)
    },
    dispose: () => resources.dispose()
  };
}
