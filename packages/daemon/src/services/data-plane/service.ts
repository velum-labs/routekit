import { Context } from "effect";

export type DataPlaneValue = {
  token: string;
  path: string;
  cache: Map<string, string>;
};

export class DataPlane extends Context.Service<DataPlane, DataPlaneValue>()(
  "@velum-labs/routekit-daemon/DataPlane"
) {}
