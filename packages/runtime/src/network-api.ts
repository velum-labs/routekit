export { gatewayOpenAiBaseUrl, gatewayOrigin, gatewayPath } from "./network/gateway-url.js";
export type {
  DetectedProxy,
  DiscoverOrSpawnInput,
  DiscoverOrSpawnResult,
  PortlessModule,
  PortlessOptions,
  PortlessSession,
  RouteMapping,
  RouteStoreLike,
  SpawnedService
} from "./network/portless.js";
export {
  createActivePortlessSession,
  createPortlessSession,
  detectPortlessProxy,
  reapPortlessProject,
  reapPortlessService
} from "./network/portless.js";
export {
  assertAuthenticatedBind,
  isLoopbackHost,
  normalizeApiBaseUrl,
  trimSurroundingSlashes,
  trimTrailingSlashes
} from "./network/url.js";
