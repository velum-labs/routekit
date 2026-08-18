import { Context } from "effect";

import type { CliproxySidecar } from "../../cliproxy-sidecar.js";

export class Sidecar extends Context.Service<Sidecar, CliproxySidecar>()(
  "@velum-labs/routekit-daemon/Sidecar"
) {}
