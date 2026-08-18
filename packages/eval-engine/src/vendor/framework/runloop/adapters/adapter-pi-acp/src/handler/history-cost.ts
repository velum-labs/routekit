import { Option, Schema } from "effect";

import { PiUsage } from "../native/usage.ts";

export const costFromHistory = (messages: readonly unknown[]): number => {
  let total = 0;
  for (const message of messages) {
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({
        role: Schema.Literal("assistant"),
        usage: PiUsage,
      })
    )(message);
    const cost = Option.getOrUndefined(decoded)?.usage.cost?.total;
    if (cost !== undefined && cost > 0) {
      total += cost;
    }
  }
  return total;
};
