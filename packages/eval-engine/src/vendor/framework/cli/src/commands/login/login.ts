import { DateTime, Duration, Effect, Option } from "effect";

import type { OpenRouterAuthSource } from "../../../../contracts/internal/src/openrouter-auth.ts";
import type { AnnounceAuthorizationInput } from "./login-presentation.ts";
import type { AuthStorageScope } from "../../ori-directory.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { writeProgressNotice } from "../dev/progress-notice.ts";
import { startCallbackServer } from "./callback-server.ts";
import {
  hasAmbientOpenRouterKey,
  hasOpenRouterKeyInEnv,
  hasResolvableOpenRouterCredential,
  environmentOpenRouterAuthSource,
  loadStoredOpenRouterKeyIntoEnvFrom,
  restoreDotenvOpenRouterCredentialAtStartup,
  resolveOpenRouterAuthSource,
  writeAuthCredentials,
} from "./credentials.ts";
import { resolveProjectCredentialConflict } from "./credentials-choice.ts";
import {
  announceAuthorization,
  formatSuccess,
} from "./login-presentation.ts";
import { exchangeCodeForKey } from "./oauth.ts";
import {
  buildAuthUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
} from "./pkce.ts";
import { isInteractiveTerminal } from "../../interactive-terminal.ts";
import { resolveStartDir } from "../../ori-directory.ts";

const LOGIN_CALLBACK_TIMEOUT_MS = 300_000;

interface RunLoginOptions {
  readonly callbackPort?: number | undefined;
  readonly noBrowser: boolean;
  readonly scope: AuthStorageScope;
  /** Overrides the workspace search start directory; primarily a test seam. */
  readonly startDir?: string;
}

interface EnsureOpenRouterKeyOptions {
  readonly callbackPort?: number;
  readonly noBrowser?: boolean;
  readonly scope?: AuthStorageScope;
  readonly startDir?: string;
}

const runLogin = Effect.fn("Login.run")(function* (options: RunLoginOptions) {
  const cliIo = yield* CliIo;
  const startDir = yield* resolveStartDir(options.startDir);

  yield* Effect.gen(function* () {
    const server = yield* startCallbackServer({ port: options.callbackPort });
    const codeVerifier = yield* generateCodeVerifier;
    const codeChallenge = yield* deriveCodeChallenge(codeVerifier);
    const authUrl = buildAuthUrl({
      callbackUrl: server.callbackUrl,
      codeChallenge,
    });

    yield* announceAuthorization({
      authUrl,
      cliIo,
      noBrowser: options.noBrowser,
    });

    const code = yield* server.awaitCode.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(LOGIN_CALLBACK_TIMEOUT_MS),
        orElse: () =>
          new CliFailureError({
            detail:
              "Timed out waiting for OpenRouter authorization. Run `ori login` again when ready.",
          }),
      })
    );
    const exchanged = yield* exchangeCodeForKey({
      code,
      codeVerifier,
    });
    const now = yield* DateTime.now;
    const savedPath = yield* writeAuthCredentials({
      credentials: {
        createdAt: DateTime.formatIso(now),
        key: exchanged.key,
        userId: exchanged.userId,
      },
      scope: options.scope,
      startDir,
    });

    yield* cliIo.writeStdout(formatSuccess(exchanged.userId, savedPath));
  }).pipe(Effect.scoped);
});

const ensureOpenRouterKeyIntoEnv = Effect.fn("Login.ensureOpenRouterKey")(
  function* (options: EnsureOpenRouterKeyOptions = {}) {
    const startDir = yield* resolveStartDir(options.startDir);

    yield* loadStoredOpenRouterKeyIntoEnvFrom({
      startDir,
    });
    if (yield* hasOpenRouterKeyInEnv()) {
      return;
    }

    yield* runLogin({
      callbackPort: options.callbackPort,
      noBrowser: options.noBrowser ?? false,
      scope: options.scope ?? "workspace-preferred",
      startDir,
    });
    yield* loadStoredOpenRouterKeyIntoEnvFrom({
      startDir,
    });
  }
);

interface EnsureCredentialOptions {
  /**
   * When false, a missing credential is treated as it would be with no
   * terminal: the gate never runs interactive login. A caller whose stdout
   * carries one machine-readable document needs this, because login prints the
   * authorization URL and the success line to stdout and stdin can be a TTY
   * while stdout is a pipe.
   */
  readonly allowInteractiveLogin?: boolean;
  readonly callbackPort?: number;
  /**
   * The command the caller is about to run, named in the "not signed in"
   * diagnostic ("Run `ori login` before `ori <command>`"). Pass it when the
   * gate guards a specific command, so a non-interactive failure points at the
   * command the user actually ran.
   *
   * Omit it when there is no next command to name. `ori init` scaffolds a
   * workspace and hands back, so any command it named would be a guess, and an
   * agent reading the hint would follow the guess. Without one the diagnostic
   * states the condition instead: sign in before anything that calls a model.
   */
  readonly commandName?: string;
  readonly mode?: "resolvable" | "workspace" | "workspace-with-global-fallback";
  readonly noBrowser?: boolean;
  readonly onNonInteractiveMissing?: "fail" | "hint";
  readonly allowProjectCredentialChoice?: boolean;
  /**
   * When true, prefer the workspace-local run credential `.ori/start.json` over
   * `.ori/credentials.json` (used by `ori start`, RFC 0004 start.md). Only
   * affects the `workspace` and `workspace-with-global-fallback` modes; the
   * global and resolvable lookups are unchanged.
   */
  readonly preferRunCredential?: boolean;
  /** Overrides the workspace search start directory; primarily a test seam. */
  readonly startDir?: string;
}

/**
 * Loads a workspace-scoped credential into the environment: workspace files
 * only (never global), overriding any existing env key. Shared by the
 * workspace and workspace-with-global-fallback resolution paths.
 */
const loadWorkspaceCredentialIntoEnv = (input: {
  readonly preferRunCredential?: boolean;
  readonly startDir: string;
}): ReturnType<typeof loadStoredOpenRouterKeyIntoEnvFrom> =>
  loadStoredOpenRouterKeyIntoEnvFrom(
    {
      startDir: input.startDir,
    },
    {
      includeGlobal: false,
      overrideExistingEnv: true,
      preferRunCredential: input.preferRunCredential ?? false,
      workspaceRoot: input.startDir,
    }
  );

/**
 * Resolve a credential for the default `ori dev` / `ori start` gate: prefer the
 * workspace-local `.ori/credentials.json` (overriding any inherited env key so
 * the workspace stays pinned to its own credential — ORI-94), and otherwise
 * fall back to a *genuinely inherited* `OPENROUTER_API_KEY`.
 *
 * Crucially, the fallback consults {@link hasAmbientOpenRouterKey} — the
 * snapshot of the env key taken at CLI startup *before* the bootstrap pre-loads
 * any stored credential — NOT the live env. The bootstrap (`ori.ts`) loads the
 * global `~/.ori/credentials.json` into the same process env for every command,
 * so a live env check here would treat that bootstrap-loaded global key as an
 * "inherited" key and silently defeat workspace isolation. The global credential
 * stays gated behind `--global-auth`. Shared by the `workspace` and
 * `workspace-with-global-fallback` resolution paths.
 */
const loadWorkspaceOrEnvCredentialIntoEnv = Effect.fn(
  "Login.loadWorkspaceOrEnvCredentialIntoEnv"
)(function* (input: {
  readonly preferRunCredential?: boolean;
  readonly startDir: string;
}) {
  const workspaceCredential = yield* loadWorkspaceCredentialIntoEnv(input);
  if (Option.isSome(workspaceCredential)) {
    return workspaceCredential;
  }
  if (yield* hasAmbientOpenRouterKey()) {
    return Option.some(environmentOpenRouterAuthSource);
  }
  return Option.none<OpenRouterAuthSource>();
});

const ensureConfiguredCredential = Effect.fn(
  "Login.ensureConfiguredCredential"
)(function* (input: {
  readonly allowProjectCredentialChoice: boolean;
  readonly interactiveProjectCredentialChoice: boolean;
  readonly mode: NonNullable<EnsureCredentialOptions["mode"]>;
  readonly preferRunCredential?: boolean;
  readonly startDir: string;
}) {
  if (input.mode === "workspace") {
    const workspaceOrEnvCredential =
      yield* loadWorkspaceOrEnvCredentialIntoEnv(input);
    return Option.isSome(workspaceOrEnvCredential)
      ? workspaceOrEnvCredential
      : yield* restoreDotenvOpenRouterCredentialAtStartup(input.startDir);
  }

  if (input.mode === "workspace-with-global-fallback") {
    const workspaceOrEnvCredential =
      yield* loadWorkspaceOrEnvCredentialIntoEnv(input);
    if (Option.isSome(workspaceOrEnvCredential)) {
      return workspaceOrEnvCredential;
    }
    const globalCredential = yield* loadStoredOpenRouterKeyIntoEnvFrom(
      {
        startDir: input.startDir,
      },
      {
        includeGlobal: true,
        workspaceRoot: input.startDir,
      }
    );
    return Option.isSome(globalCredential)
      ? globalCredential
      : yield* restoreDotenvOpenRouterCredentialAtStartup(input.startDir);
  }

  const existingSource = yield* resolveOpenRouterAuthSource(input.startDir);
  if (
    Option.isSome(existingSource) &&
    existingSource.value.kind === "environment"
  ) {
    return existingSource;
  }
  const projectCredential = input.allowProjectCredentialChoice
    ? yield* resolveProjectCredentialConflict({
        existingSource,
        interactive: input.interactiveProjectCredentialChoice,
        startDir: input.startDir,
      })
    : Option.none<OpenRouterAuthSource>();
  if (Option.isSome(projectCredential)) {
    return projectCredential;
  }
  const hasCredential = yield* hasResolvableOpenRouterCredential({
    startDir: input.startDir,
  });
  if (hasCredential) {
    return yield* loadStoredOpenRouterKeyIntoEnvFrom({
      startDir: input.startDir,
    });
  }
  return Option.isSome(existingSource)
    ? existingSource
    : yield* restoreDotenvOpenRouterCredentialAtStartup(input.startDir);
});

const loadCredentialIntoEnvForMode = (input: {
  readonly mode: NonNullable<EnsureCredentialOptions["mode"]>;
  readonly preferRunCredential?: boolean;
  readonly startDir: string;
}): ReturnType<typeof loadStoredOpenRouterKeyIntoEnvFrom> => {
  if (
    input.mode === "workspace" ||
    input.mode === "workspace-with-global-fallback"
  ) {
    return loadWorkspaceCredentialIntoEnv(input);
  }
  return loadStoredOpenRouterKeyIntoEnvFrom({
    startDir: input.startDir,
  });
};

/**
 * The "not signed in" diagnostic. With a `commandName` it points at that command,
 * which is what a caller guarding one wants. Without one it names the condition
 * a credential is needed for instead of a command, so a caller that does not know
 * what runs next (`ori init`) never sends a reader somewhere it made up.
 */
const missingCredentialMessage = (
  mode: NonNullable<EnsureCredentialOptions["mode"]>,
  commandName: string | undefined
): string => {
  const workspaceScoped =
    mode === "workspace" || mode === "workspace-with-global-fallback";
  if (commandName === undefined) {
    return workspaceScoped
      ? "\nYou're not signed in to OpenRouter for this Ori workspace yet. Run `ori login --local` before anything that calls a model.\n"
      : "\nYou're not signed in to OpenRouter yet. Run `ori login` before anything that calls a model.\n";
  }
  return workspaceScoped
    ? `\nYou're not signed in to OpenRouter for this Ori workspace yet. Run \`ori login --local\` before \`ori ${commandName}\`, or pass \`ori ${commandName} --global-auth\` to allow global auth for this session.\n`
    : `\nYou're not signed in to OpenRouter yet. Run \`ori login\` before \`ori ${commandName}\`.\n`;
};

/**
 * Shared onboarding credential gate (ORI-20): commands that need an OpenRouter
 * key (`ori init`, `ori dev`) call this before doing work that would otherwise
 * fail later with a confusing auth error.
 *
 * The default mode accepts any resolvable credential for onboarding commands.
 * Workspace mode is stricter for `ori dev`: it requires local workspace auth,
 * runs interactive login into that workspace, and can fail non-interactive runs
 * before the runtime starts.
 */
export const ensureOpenRouterCredential = Effect.fn("Login.ensureCredential")(
  function* (options: EnsureCredentialOptions = {}) {
    const cliIo = yield* CliIo;
    const hostProcess = yield* HostProcess;
    const startDir = yield* resolveStartDir(options.startDir);
    const mode = options.mode ?? "resolvable";
    const isTty = yield* cliIo.isStdinTty;
    const env = yield* hostProcess.env;
    const allowProjectCredentialChoice =
      options.allowProjectCredentialChoice === true;

    const preferRunCredential = options.preferRunCredential ?? false;
    const configuredCredential = yield* ensureConfiguredCredential({
      allowProjectCredentialChoice,
      interactiveProjectCredentialChoice:
        allowProjectCredentialChoice &&
        isInteractiveTerminal({
          env,
          isStdinTty: isTty,
        }) &&
        options.allowInteractiveLogin !== false,
      mode,
      preferRunCredential,
      startDir,
    });
    if (Option.isSome(configuredCredential)) {
      return configuredCredential;
    }

    if (!isTty || options.allowInteractiveLogin === false) {
      const message = missingCredentialMessage(mode, options.commandName);
      if (options.onNonInteractiveMissing === "fail") {
        return yield* new CliFailureError({ detail: message.trim() });
      }
      // A notice about the run, not the run's result: in json mode stdout is
      // carrying the caller's envelope, so this belongs on stderr next to the
      // rest of the diagnostics.
      yield* writeProgressNotice(message);
      return Option.none<OpenRouterAuthSource>();
    }

    yield* writeProgressNotice(
      "\nYou're not signed in to OpenRouter yet. Let's fix that...\n"
    );
    yield* runLogin({
      callbackPort: options.callbackPort,
      noBrowser: options.noBrowser ?? false,
      scope:
        mode === "workspace" || mode === "workspace-with-global-fallback"
          ? "workspace"
          : "workspace-preferred",
      startDir,
    });
    const loadedCredential = yield* loadCredentialIntoEnvForMode({
      mode,
      preferRunCredential,
      startDir,
    });
    if (Option.isSome(loadedCredential)) {
      return loadedCredential;
    }
    return yield* new CliFailureError({
      detail: missingCredentialMessage(mode, options.commandName).trim(),
    });
  }
);

export { announceAuthorization, runLogin, ensureOpenRouterKeyIntoEnv };
export type {
  RunLoginOptions,
  EnsureOpenRouterKeyOptions,
  AnnounceAuthorizationInput,
  EnsureCredentialOptions,
};
