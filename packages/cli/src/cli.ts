import {
  type CliRuntime,
  immutableCliRuntime,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type * as Command from "effect/unstable/cli/Command";

import { CliSession } from "./cli-session.js";
import { buildEffectProgram } from "./effect/program.js";
export { routekitVersion } from "./state.js";

export type RouteKitProgram = Command.Command.Any & {
  readonly runtime: CliRuntime;
  readonly session: CliSession;
};

export function buildProgram(runtimeInput: CliRuntime = processCliRuntime): RouteKitProgram {
  const runtime = immutableCliRuntime(runtimeInput);
  const session = new CliSession(runtime);
  return Object.assign(buildEffectProgram(session, runtime), { runtime, session });
}
