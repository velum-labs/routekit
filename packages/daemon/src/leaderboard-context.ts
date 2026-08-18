import type { LeaderboardConfig } from "@velum-labs/routekit-config";
import { Context } from "effect";

import type { LeaderboardRollupStore } from "./leaderboard.js";

export type LeaderboardValue = {
  rollups: LeaderboardRollupStore;
  config: () => LeaderboardConfig;
};

export class Leaderboard extends Context.Service<Leaderboard, LeaderboardValue>()(
  "@velum-labs/routekit-daemon/Leaderboard"
) {}
