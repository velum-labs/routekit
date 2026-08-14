import type { AccountTransactionRecovery } from "./account-transaction.js";

export type AccountApplicationServiceOptions = {
  recovery: AccountTransactionRecovery;
  onTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};
