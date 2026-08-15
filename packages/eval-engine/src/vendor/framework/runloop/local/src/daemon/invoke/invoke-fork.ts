import { Effect } from "effect";

import type { RuntimeJournalError } from "../../../../../contracts/internal/src/errors.ts";
import type { SessionId } from "../../../../../contracts/internal/src/ids.ts";
import type {
  OriDaemonServices,
  RuntimeCommand,
} from "../core/types.ts";
import type { RolloverResolution } from "../../event/rollover-stream.ts";

import { RuntimeValidationError } from "../../../../../contracts/internal/src/errors.ts";
import {
  composeForkSeedPrompt,
  parentIsKnown,
  planFork,
  summarizeParentThread,
} from "../../event/fork-thread.ts";

export const resolveFork = Effect.fn("Daemon.resolveFork")(function* (
  services: OriDaemonServices,
  command: RuntimeCommand
): Effect.fn.Return<
  {
    readonly command: RuntimeCommand;
    readonly parentSessionId: SessionId | undefined;
  },
  RuntimeValidationError | RuntimeJournalError
> {
  const planned = planFork(command);
  if (!planned.ok) {
    return yield* planned.error;
  }
  if (planned.plan === null) {
    return {
      command,
      parentSessionId: undefined,
    };
  }
  const { parentSessionId } = planned.plan;
  const entries = yield* services.journal.entries();
  if (!parentIsKnown(entries, parentSessionId)) {
    return yield* new RuntimeValidationError({
      cause: undefined,
      detail: `fork parent session "${parentSessionId}" is unknown to this daemon`,
    });
  }

  const seededPrompt = composeForkSeedPrompt({
    parentSessionId,
    parentSummary: summarizeParentThread(entries, parentSessionId),
    forkInstruction: command.prompt,
  });
  // Drop sessionId so the harness mints a fresh session for the child run.
  const { fork: _fork, sessionId: _sessionId, ...rest } = command;
  return {
    command: {
      ...rest,
      prompt: seededPrompt,
    },
    parentSessionId,
  };
});

export const commandReceivedMessage = (
  parentSessionId: SessionId | undefined,
  rollover: RolloverResolution | null
): string => {
  if (parentSessionId !== undefined) {
    return "accepted fork-thread command";
  }
  if (rollover === null) {
    return "accepted agent command";
  }
  return "accepted agent command (rollover pending)";
};
