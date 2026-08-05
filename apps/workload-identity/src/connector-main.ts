#!/usr/bin/env node
import { parseConnectorConfig, readJsonConfig } from "./config.js";
import { startConnector } from "./connector.js";

const path = process.env.ROUTEKIT_WORKLOAD_CONNECTOR_CONFIG;
if (path === undefined || path.length === 0) {
  throw new Error("ROUTEKIT_WORKLOAD_CONNECTOR_CONFIG is required");
}
const connector = await startConnector(parseConnectorConfig(readJsonConfig(path)));
console.log(`RouteKit workload connector listening at ${connector.url}`);

const shutdown = (): void => {
  void connector.close().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
