import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningControlServer } from "@velum-labs/routekit-runtime/control";
import { Context, Layer } from "effect";
import type { RunningGatewayGeneration } from "../gateway-generation/service.js";

export type ActiveGatewayValue = {
  router(): RunningGatewayGeneration | undefined;
  setRouter(router: RunningGatewayGeneration): void;
  proxy(): SwitchingGatewayProxy | undefined;
  setProxy(proxy: SwitchingGatewayProxy): void;
  dataUrl(): string | undefined;
  setDataUrl(url: string): void;
  control(): RunningControlServer | undefined;
  setControl(control: RunningControlServer): void;
};

export class ActiveGateway extends Context.Service<ActiveGateway, ActiveGatewayValue>()(
  "@velum-labs/routekit-daemon/ActiveGateway"
) {
  static readonly layer = Layer.sync(ActiveGateway, () => {
    let router: RunningGatewayGeneration | undefined;
    let proxy: SwitchingGatewayProxy | undefined;
    let dataUrl: string | undefined;
    let control: RunningControlServer | undefined;
    return {
      router: () => router,
      setRouter: (next) => {
        router = next;
      },
      proxy: () => proxy,
      setProxy: (next) => {
        proxy = next;
      },
      dataUrl: () => dataUrl,
      setDataUrl: (next) => {
        dataUrl = next;
      },
      control: () => control,
      setControl: (next) => {
        control = next;
      }
    };
  });
}
