import { Context } from "effect";

import type { AccountTransactionRecovery } from "./account-transaction.js";

export class AccountRecovery extends Context.Service<AccountRecovery, AccountTransactionRecovery>()(
  "@velum-labs/routekit-daemon/AccountRecovery"
) {}
