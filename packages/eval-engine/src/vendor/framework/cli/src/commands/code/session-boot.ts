import { Crypto, Effect } from "effect";

import type { DevEventLogFileHandle } from "../dev/event-log-file.ts";
import type {
  DevCommandRuntimeOptions,
  HeadlessRuntimeSessionConfig,
} from "../dev/session-support.ts";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { runCodeHeadlessTurn } from "./headless-run.ts";
import { runCodeOneShotJsonlTurn } from "./one-shot.ts";
import { codeHeadlessInvokeCommand } from "./session-config.ts";
import { publishDevDescriptor } from "../dev/publish-descriptor.ts";
import {
  prepareDevFeaturesRoot,
  startDevDaemon,
  startDevEventLogFile,
} from "../dev/session-support.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

type CodeDaemonConfig = Parameters<typeof startDevDaemon>[1];

export const codeDaemonConfig = (
  session: HeadlessRuntimeSessionConfig,
  featuresRoot: string,
  attachedTui: boolean
): CodeDaemonConfig => ({
  authSource: session.authSource,
  devLogWorkspaceRoot: session.descriptorWorkspaceRoot,
  enableDevRoutes: session.enableDevRoutes,
  externalSkillsRoot: session.externalSkillsRoot,
  featuresRoot,
  host: session.host,
  port: session.port,
  suppressAuditStdout: true,
  suppressBootLine: true,
  suppressTuiLogs: attachedTui,
});

/**
 * Boot the daemon for an `ori code` session, in the one shape both session
 * kinds need: prepare the features root, start the daemon with audit and boot
 * output suppressed, publish the descriptor so `ori tui`/`ori logs` can find
 * the session, and start the event log file when one is configured.
 *
 * The two suppress flags are load-bearing rather than cosmetic. An attached
 * chat owns the terminal, and a headless run's stdout carries only the agent's
 * prose, so a daemon audit line on either would corrupt the surface it shares.
 */
export const bootCodeSession = Effect.fn("CodeCommand.bootSession")(function* (
  options: DevCommandRuntimeOptions,
  session: HeadlessRuntimeSessionConfig,
  config: { readonly attachedTui: boolean }
) {
  const { featuresRoot } = yield* prepareDevFeaturesRoot(session);
  const daemon = yield* startDevDaemon(
    options,
    codeDaemonConfig(session, featuresRoot, config.attachedTui)
  );
  const workspaceRoot = yield* publishDevDescriptor(featuresRoot, daemon, {
    descriptorWorkspaceRoot: session.descriptorWorkspaceRoot,
    // `ori code` anchors to the user's arbitrary launch cwd, not a feature
    // workspace — don't refresh (and litter) an `.ori/docs` cache there.
    skipDocsCache: true,
  });

  const eventLog: DevEventLogFileHandle | undefined =
    session.eventLog === undefined
      ? undefined
      : yield* startDevEventLogFile({
          retention: session.eventLog.retention,
          runLabel: session.runtimeLabel,
          runtime: daemon.runtime,
          workspaceRoot,
        });

  return {
    daemon,
    eventLog,
    featuresRoot,
    workspaceRoot,
  };
});

/**
 * Boot the daemon and run a single headless turn against it, for a piped
 * `ori code -p "<prompt>"`. The features root comes from the boot rather than
 * the command inputs: the boot is what materializes the coding bundle, so the
 * input's root is not yet the one the daemon is serving.
 *
 * `output` picks the surface: `prose` prints the assistant's answer once the
 * turn settles (the default), `jsonl` streams every runtime event as
 * CliStreamLine NDJSON with a
 * terminal result line and advertises an interaction surface the run settles
 * itself (RFC 0004 code.md "Structured output").
 */
export const runCodeHeadlessSession = Effect.fn("CodeCommand.headlessSession")(
  function* (input: {
    readonly harness?: string | undefined;
    readonly launchCwd: string;
    readonly model?: string | undefined;
    readonly options: DevCommandRuntimeOptions;
    readonly output: "jsonl" | "prose";
    readonly prompt: string;
    readonly session: HeadlessRuntimeSessionConfig;
    readonly sessionId?: string | undefined;
  }) {
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* crypto.randomUUIDv7.pipe(
      Effect.mapError(
        (cause) =>
          new CliFailureError({
            detail: `Could not start the headless run: ${formatUnknownError(cause)}`,
          })
      )
    );
    const boot = yield* bootCodeSession(input.options, input.session, {
      attachedTui: false,
    });
    const command = codeHeadlessInvokeCommand({
      commandId,
      featuresRoot: boot.featuresRoot,
      harness: input.harness,
      interactionSurface: input.output === "jsonl",
      launchCwd: input.launchCwd,
      model: input.model,
      prompt: input.prompt,
      sessionId: input.sessionId,
    });
    const turn =
      input.output === "jsonl"
        ? runCodeOneShotJsonlTurn({
            command,
            daemon: boot.daemon,
          })
        : runCodeHeadlessTurn({
            command,
            daemon: boot.daemon,
          });
    return yield* turn.pipe(
      Effect.ensuring(boot.eventLog?.flush ?? Effect.void)
    );
  }
);
