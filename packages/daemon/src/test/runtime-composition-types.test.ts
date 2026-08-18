import test from "node:test";

import type { TokenStore } from "@velum-labs/routekit-runtime/tokens";

import type { CliproxySidecar } from "../cliproxy-sidecar.js";
import { daemonLive } from "../effect/daemon-live.js";
import type { ActiveGatewayValue } from "../services/active-gateway/service.js";

test("daemon runtime composition rejects prebuilt coordinator bags at compile time", () => {
  if (false) {
    // @ts-expect-error daemonLive constructs TokenStore; callers cannot inject one.
    daemonLive({ packageVersion: "0.0.0", tokenStore: {} as TokenStore });
    // @ts-expect-error daemonLive constructs/acquires the sidecar adapter.
    daemonLive({ packageVersion: "0.0.0", sidecar: {} as CliproxySidecar });

    const gateway = undefined as unknown as ActiveGatewayValue;
    // @ts-expect-error generation publication is Ref-owned, not a setter bag.
    gateway.setRouter(undefined);
    // @ts-expect-error data-plane publication is Ref-owned, not a setter bag.
    gateway.setDataUrl("http://127.0.0.1:8080");
  }
});
