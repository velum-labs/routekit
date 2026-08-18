import type { ValueOf } from "../../../utils/core/src/types.ts";

export const BuiltinName = {
  Chat: "tui",
  Db: "sqlite",
  Harness: "pi",
  Model: "model",
  Skill: "feature-development",
  Secret: "temp",
  UpstreamSecret: "vault",
  Vcs: "github",
} as const;
export type BuiltinName = ValueOf<typeof BuiltinName>;
