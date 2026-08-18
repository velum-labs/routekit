import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { AccountEnrollService } from "./account-enroll-service.js";
import { AccountMutationService } from "./account-mutation-service.js";
import { AccountQueryService } from "./account-query-service.js";
import { DaemonLifecycleService } from "./daemon-lifecycle-service.js";
import { DoctorApplicationService } from "./doctor-service.js";
import { EvalRoutingApplicationService } from "./eval-routing-service.js";
import { EvalSessionApplicationService } from "./services/eval-session/service.js";
import { LauncherApplicationService } from "./launcher-service.js";
import { ProviderQueryService } from "./provider-query-service.js";
import { RouterGenerationService } from "./router-generation-service.js";
import { TelemetryApplicationService } from "./telemetry-application-service.js";
import { TokenApplicationService } from "./token-application-service.js";

/**
 * Composes owned application services into the daemon control handler map.
 * Protocol policy lives in the method table; this function only binds use cases.
 * Daemon-lifetime state is yielded from `daemonLive`.
 */
export function createDaemonControlHandlers(): EffectRouteKitControlHandlers {
  const providerHandlers = new ProviderQueryService().handlers();
  return {
    ...new DaemonLifecycleService().handlers(),
    ...new RouterGenerationService().handlers(),
    ...providerHandlers,
    ...new AccountQueryService().handlers(),
    ...new AccountEnrollService().handlers(),
    ...new AccountMutationService().handlers(),
    ...new TelemetryApplicationService().handlers(),
    ...new DoctorApplicationService().handlers(),
    ...new LauncherApplicationService({
      listModels: providerHandlers["models.list"]
    }).handlers(),
    ...new TokenApplicationService().handlers(),
    ...new EvalRoutingApplicationService().handlers(),
    ...new EvalSessionApplicationService().handlers()
  };
}
