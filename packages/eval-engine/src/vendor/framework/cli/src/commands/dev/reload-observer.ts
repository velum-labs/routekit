import type { Scope } from "effect";

import { Cause, Effect } from "effect";

import type { CliIoShape } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type { ReloadGenerationAnalysis } from "./reload.ts";

import { formatError } from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

export interface AppliedDevReload {
  readonly analysis: ReloadGenerationAnalysis;
  readonly changedPaths: readonly string[];
}

export const notifyAppliedReloadObserver = <E>(
  cliIo: CliIoShape,
  observer: (reload: AppliedDevReload) => Effect.Effect<void, E>,
  reload: AppliedDevReload
): Effect.Effect<void, never, Scope.Scope> =>
  observer(reload).pipe(
    Effect.catchCause((cause) =>
      cliIo.writeStderr(
        `${formatError(`reload: observer failed: ${formatUnknownError(Cause.squash(cause))}`)}\n`
      )
    ),
    Effect.forkScoped,
    Effect.asVoid
  );
