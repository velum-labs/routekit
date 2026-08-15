import type { HashSet } from "effect";

import { Cause, Effect, Ref } from "effect";

import type { CliIoShape } from "../../../../contracts/internal/src/cli/cli-io.ts";

import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const EMPTY_COUNT = 0;

// Log (and swallow) a filesystem snapshot failure, returning a fallback so one
// unreadable entry never aborts the whole snapshot (ROUTEKIT_EVAL-248).
export const onSnapshotError =
  <A>(cliIo: CliIoShape, detail: string, fallback: A) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<A> =>
    cliIo
      .writeStderr(
        `[reload] snapshot: ${detail}: ${formatUnknownError(Cause.squash(cause))}\n`
      )
      .pipe(Effect.ignore, Effect.as(fallback));

export const logWatcherStopped =
  (cliIo: CliIoShape, pending: Ref.Ref<HashSet.HashSet<string>>) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Effect.gen(function* () {
      // A clean `routekit-eval dev` exit disposes the watcher's scope, which interrupts this
      // fiber. That is not a failure, so stay silent and only report genuine
      // stream/fiber deaths (ROUTEKIT_EVAL-248) instead of logging on every shutdown.
      if (Cause.hasInterruptsOnly(cause)) {
        return;
      }
      const stuck = [...(yield* Ref.get(pending))].toSorted();
      const paths =
        stuck.length === EMPTY_COUNT ? "none pending" : stuck.join(", ");
      yield* cliIo.writeStderr(
        `[reload] watcher stopped: ${formatUnknownError(Cause.squash(cause))}; paths: ${paths}\n`
      );
    }).pipe(Effect.ignore);

export const formatDiagnosticList = (diagnostics: readonly string[]): string =>
  diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n");

export const formatDrainResult = (drain: {
  readonly activeCount: number;
  readonly drained: boolean;
}): string =>
  drain.drained
    ? "in-flight runs drained"
    : `still waiting on ${drain.activeCount} in-flight run(s) after the drain timeout`;
