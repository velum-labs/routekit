import type { RouterConfig } from "@velum-labs/routekit-config";
import { Context } from "effect";

export type DaemonPolicyValue = {
  wantsCliproxySidecar: (config: RouterConfig) => boolean;
};

export class DaemonPolicy extends Context.Service<DaemonPolicy, DaemonPolicyValue>()(
  "@velum-labs/routekit-daemon/DaemonPolicy"
) {}
