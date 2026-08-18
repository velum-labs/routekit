import type { TokenStore } from "@velum-labs/routekit-runtime/tokens";
import { Context } from "effect";

export class Tokens extends Context.Service<Tokens, TokenStore>()(
  "@velum-labs/routekit-daemon/Tokens"
) {}
