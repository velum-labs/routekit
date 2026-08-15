import { Effect, Option } from "effect";

import type { InvokeRuntimeCommand } from "../../../../contracts/internal/src/runtime/command.ts";
import type { CodeOutputFormat } from "./one-shot-launch.ts";
import type {
  DevCommandAuthSource,
  DevLogRetentionOverrides,
  HeadlessRuntimeSessionConfig,
} from "../dev/session-support.ts";
import type { InitialPromptConfig } from "../initial-prompt.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import {
  HarnessName,
  RuntimeCommandId,
  SessionId,
} from "../../../../contracts/internal/src/ids.ts";
import { RuntimeCommandTag } from "../../../../contracts/internal/src/runtime/command.ts";
import { resolveLatestSessionIdInWorkspace } from "../../../../runloop/local/src/dev/log-sessions.ts";

// Session-input resolution for `routekit-eval code`: the config builders plus the
// --resume/--session resolver. Session types import as type-only so no runtime
// daemon/PTY code enters the coverage graph — the untestable boot wiring stays
// out of the aggregate denominator while the decision logic here stays fully
// unit-tested. The resolver's only runtime reach is the session sidecar read
// (dev-log-sessions) and CLI IO for its not-found notice.

/**
 * Map the `--global-auth` flag to a credential-gate mode. The default (on) uses
 * `resolvable`, which is exactly what `routekit-eval login` does: it resolves env →
 * workspace `.routekit-eval/credentials.json` → global `~/.routekit-eval/credentials.json` →
 * `~/.gateway/credentials.json`, and — crucially for a command that runs in
 * arbitrary directories — when no credential is found it runs interactive login
 * at `workspace-preferred` scope, the same scope `routekit-eval login` (no `--local`)
 * uses. `workspace-with-global-fallback` (used by `routekit-eval dev`) would instead drive
 * login at `workspace` scope, which fails with WorkspaceRootNotFound outside an
 * RouteKitEval workspace — the very directories `routekit-eval code` targets. `--no-global-auth`
 * opts into the strict `workspace` mode (matches `routekit-eval login --local`).
 */
const codeCredentialMode = (globalAuth: boolean): "resolvable" | "workspace" =>
  globalAuth ? "resolvable" : "workspace";

// `routekit-eval code` keeps the default event-log retention (flag > env > built-in
// default); it exposes no retention flags of its own to stay zero-config.
const CODE_EVENT_LOG_RETENTION: DevLogRetentionOverrides = {
  maxAgeDays: undefined,
  maxRuns: undefined,
  maxTotalMb: undefined,
};

/** Inputs for `routekit-eval code` session config, resolved before daemon boot. */
export interface CodeSessionInputs {
  readonly authSource: DevCommandAuthSource;
  readonly featuresRoot: string;
  /** Optional harness id from `--harness`, forwarded to the child `routekit-eval tui`. */
  readonly harness?: string;
  readonly host: string;
  readonly launchCwd: string;
  /** Optional model slug from `--model`, forwarded to the child `routekit-eval tui`. */
  readonly model?: string;
  readonly port: Option.Option<number>;
  /**
   * Optional session id to resume (from `--resume` or `--session`), forwarded
   * to the child `routekit-eval tui` as `--session`.
   */
  readonly sessionId?: string;
}

/**
 * Build the argv for the child `routekit-eval tui` that `routekit-eval code` attaches. `routekit-eval code`
 * has no model or harness registry of its own, so `--model` and `--harness`
 * overrides are forwarded to the TUI, which already threads them into each
 * turn's invoke. No prompt is ever forwarded: a prompt selects a headless run,
 * which never reaches this path.
 */
export const codeTuiChildArgs = (input: {
  readonly cwd: string;
  readonly harness?: string | undefined;
  readonly host: string;
  readonly model?: string | undefined;
  readonly port: number;
  readonly sessionId?: string | undefined;
}): readonly string[] => [
  "tui",
  "--host",
  input.host,
  "--port",
  String(input.port),
  ...(input.harness === undefined ? [] : ["--harness", input.harness]),
  ...(input.model === undefined ? [] : ["--model", input.model]),
  ...(input.sessionId === undefined ? [] : ["--session", input.sessionId]),
  "--cwd",
  input.cwd,
];

/**
 * Build the non-interactive (piped/CI) headless-session config, mirroring
 * `routekit-eval dev`'s scriptable fallback. `routekit-eval code` is a develop-style session (attach
 * the chat with `routekit-eval tui`), not a headless bot bridge, so it does not arm
 * schedules or start headless chat surfaces.
 */
export const codeHeadlessConfig = (
  inputs: CodeSessionInputs
): HeadlessRuntimeSessionConfig => ({
  armSchedules: false,
  authSource: inputs.authSource,
  externalSkillsRoot: inputs.launchCwd,
  // Publish `.routekit-eval/dev.json` (and the event log) into the user's launch cwd, not
  // the built-in bundle's temp dir, so an `routekit-eval tui`/`routekit-eval logs` run from their
  // project can discover this session (those clients walk up from cwd).
  descriptorWorkspaceRoot: inputs.launchCwd,
  enableDevRoutes: true,
  eventLog: { retention: CODE_EVENT_LOG_RETENTION },
  features: Option.some(inputs.featuresRoot),
  host: inputs.host,
  install: false,
  port: inputs.port,
  runtimeLabel: "code",
  startChats: false,
  watchReloads: false,
});

/**
 * Build the one-shot invoke command for a headless `routekit-eval code` turn.
 *
 * `cwd` is NOT optional here even though the schema allows omitting it: the
 * daemon falls back to its own workspace, so a headless run without it silently
 * executes in `~/.routekit-eval/global` while the audit log still records the caller's
 * directory — a wrong-directory run that reports success.
 *
 * `interactionSurface` differs by output format. The prose run passes `false`
 * so the runtime refuses inbound requests and continues rather than wait on a
 * terminal that is not there. The structured `--output jsonl` run passes
 * `true`: each request is then registered and its `permission.requested` /
 * `elicitation.requested` event reaches the stream — the machine-readable
 * question — and the run settles it immediately with the safe fallback, so
 * advertising the surface never hangs the harness (RFC 0004 code.md).
 */
export const codeHeadlessInvokeCommand = (input: {
  readonly commandId: string;
  readonly featuresRoot: string;
  readonly harness?: string | undefined;
  readonly interactionSurface: boolean;
  readonly launchCwd: string;
  readonly model?: string | undefined;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
}): InvokeRuntimeCommand => ({
  commandId: RuntimeCommandId.make(input.commandId),
  cwd: input.launchCwd,
  featuresRoot: input.featuresRoot,
  interactionSurface: input.interactionSurface,
  prompt: input.prompt,
  telemetrySurface: "code",
  type: RuntimeCommandTag.InvokeAgent,
  ...(input.harness === undefined
    ? {}
    : { harnessName: HarnessName.make(input.harness) }),
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.sessionId === undefined
    ? {}
    : { sessionId: SessionId.make(input.sessionId) }),
});

export { codeCredentialMode };

export interface CodeCommandConfig extends InitialPromptConfig {
  readonly globalAuth: boolean;
  readonly harness: Option.Option<string>;
  readonly host: string;
  readonly model: Option.Option<string>;
  /** Headless output format: assistant prose or structured JSONL (RFC 0004 code.md). */
  readonly output: CodeOutputFormat;
  readonly port: Option.Option<number>;
  readonly resume: boolean;
  readonly session: Option.Option<string>;
}

// `--session <id>` wins by being explicit; `--resume` reads the latest sidecar
// from the launch cwd. Passing both is a conflict — they name two different
// sessions — so it fails fast rather than silently picking one. A bare
// `--resume` with nothing on disk yet is not an error: it prints a notice and
// falls through to a fresh session.
export const resolveResumeSessionId = Effect.fn(
  "CodeCommand.resolveResumeSessionId"
)(function* (config: CodeCommandConfig, launchCwd: string) {
  if (config.resume && Option.isSome(config.session)) {
    return yield* new CliFailureError({
      detail: "Pass either --resume or --session <id>, not both.",
      hint: "Use --resume for the most recent session, or --session <id> for a specific one.",
    });
  }
  if (Option.isSome(config.session)) {
    return config.session.value;
  }
  if (!config.resume) {
    return;
  }
  const latest = yield* resolveLatestSessionIdInWorkspace(launchCwd);
  if (Option.isNone(latest)) {
    const cliIo = yield* CliIo;
    yield* cliIo
      .writeStderr(
        "No previous chat session found in this directory; starting a new one.\n"
      )
      .pipe(Effect.ignore);
    return;
  }
  return latest.value;
});
