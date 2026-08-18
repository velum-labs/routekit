import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningControlServer } from "@velum-labs/routekit-runtime/control";
import { Context, Effect, Layer, Ref } from "effect";
import type { RunningGatewayGeneration } from "../../gateway-generation.js";

export type ActiveGatewayState = Readonly<{
  router?: RunningGatewayGeneration;
  proxy?: SwitchingGatewayProxy;
  dataUrl?: string;
  control?: RunningControlServer;
}>;

export type ActiveGatewayValue = {
  readonly state: Ref.Ref<ActiveGatewayState>;
  router(): RunningGatewayGeneration | undefined;
  proxy(): SwitchingGatewayProxy | undefined;
  dataUrl(): string | undefined;
  control(): RunningControlServer | undefined;
};

/** Effect-owned publication point for the active gateway generation. */
export class ActiveGateway extends Context.Service<ActiveGateway, ActiveGatewayValue>()(
  "@velum-labs/routekit-daemon/ActiveGateway"
) {
  static readonly layer = Layer.effect(
    ActiveGateway,
    Effect.map(Ref.make<ActiveGatewayState>({}), (state) => ({
      state,
      router: () => Ref.getUnsafe(state).router,
      proxy: () => Ref.getUnsafe(state).proxy,
      dataUrl: () => Ref.getUnsafe(state).dataUrl,
      control: () => Ref.getUnsafe(state).control
    }))
  );
}
