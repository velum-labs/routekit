#!/usr/bin/env node
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { startBroker } from "./broker.js";
import { parseBrokerConfig, readJsonConfig } from "./config.js";

const path = process.env.ROUTEKIT_WORKLOAD_BROKER_CONFIG;
const parameter = process.env.ROUTEKIT_WORKLOAD_BROKER_PARAMETER;
if (
  (path === undefined || path.length === 0) === (parameter === undefined || parameter.length === 0)
) {
  throw new Error(
    "set exactly one of ROUTEKIT_WORKLOAD_BROKER_CONFIG or ROUTEKIT_WORKLOAD_BROKER_PARAMETER"
  );
}
const raw =
  path !== undefined && path.length > 0
    ? readJsonConfig(path)
    : JSON.parse(
        (
          await new SSMClient({ region: process.env.AWS_REGION }).send(
            new GetParameterCommand({ Name: parameter })
          )
        ).Parameter?.Value ??
          (() => {
            throw new Error("broker SSM parameter has no value");
          })()
      );
const broker = await startBroker(parseBrokerConfig(raw));
console.log(`RouteKit workload broker listening at ${broker.url}`);

const shutdown = (): void => {
  void broker.close().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
