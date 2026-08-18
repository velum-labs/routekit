import { Context } from "effect";

export type DaemonHosted = {
  hostPid: number;
  hostStartedAt: string;
  rolling: () => boolean;
  dataUrl: () => string;
};

export type DaemonEnvValue = {
  home: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  packageVersion: string;
  generation: number;
  startedAt: string;
  hosted: DaemonHosted | undefined;
};

export class DaemonEnv extends Context.Service<DaemonEnv, DaemonEnvValue>()(
  "@velum-labs/routekit-daemon/DaemonEnv"
) {}
