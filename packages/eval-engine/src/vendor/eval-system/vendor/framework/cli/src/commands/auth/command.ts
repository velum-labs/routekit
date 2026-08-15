import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import {
  CliOutputAlreadyReported,
  renderEnvelope,
} from "../../../../contracts/internal/src/cli/cli-output.ts";
import { currentOutputMode } from "../../../../contracts/internal/src/cli/output-mode.ts";
import { reportCommandFailure } from "../../command-failure.ts";
import {
  formatAuthenticatedText,
  resolveAuthStatus,
  unauthenticatedFailure,
} from "./auth-status.ts";
import { clearWorkspaceCredentialChoice } from "../login/credentials-choice.ts";
import { RouteKitEvalDirectory, resolveStartDir } from "../../routekit-eval-directory.ts";

export const runAuthCommand = Effect.fn("AuthCommand.run")(function* (
  input: {
    readonly clearWorkspaceChoice?: boolean;
    readonly startDir?: string | undefined;
  } = {}
) {
  const cliIo = yield* CliIo;
  const mode = yield* currentOutputMode();
  if (input.clearWorkspaceChoice === true) {
    const startDir = yield* resolveStartDir(input.startDir);
    const workspaceRoot = yield* (yield* RouteKitEvalDirectory).workspaceRootFrom(
      startDir
    );
    if (Option.isSome(workspaceRoot)) {
      yield* clearWorkspaceCredentialChoice(workspaceRoot.value);
    }
  }
  const status = yield* resolveAuthStatus(input.startDir);

  if (mode === "json") {
    yield* cliIo.writeStdout(
      renderEnvelope("auth", status, status.authenticated)
    );
    return yield* status.authenticated
      ? Effect.void
      : new CliOutputAlreadyReported({
          cause: unauthenticatedFailure(status),
        });
  }

  if (!status.authenticated) {
    return yield* unauthenticatedFailure(status);
  }
  yield* cliIo.writeStdout(formatAuthenticatedText(status));
});

const clearWorkspaceChoiceFlag = Flag.boolean("clear-workspace-choice").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Forget the saved project-versus-stored credential choice for this workspace"
  )
);

export const authCommand = Command.make(
  "auth",
  { clearWorkspaceChoice: clearWorkspaceChoiceFlag },
  ({ clearWorkspaceChoice }) =>
    runAuthCommand({ clearWorkspaceChoice }).pipe(reportCommandFailure("auth"))
).pipe(
  Command.withDescription(
    "Report whether an Gateway credential resolves from the current directory, and where it comes from. Exits non-zero when none does"
  )
);
