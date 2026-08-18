import { Context } from "effect";

import type { CallAttributionStore } from "../../call-attribution-store.js";

export class CallAttributions extends Context.Service<CallAttributions, CallAttributionStore>()(
  "@velum-labs/routekit-daemon/CallAttributions"
) {}
