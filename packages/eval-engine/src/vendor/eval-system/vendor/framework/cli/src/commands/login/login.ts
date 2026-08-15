import { DateTime, Duration, Effect, Option } from "effect";

import type { GatewayAuthSource } from "../../../../contracts/internal/src/gateway-auth.ts";
import type { AnnounceAuthorizationInput } from "./login-presentation.ts";
import type { AuthStorageScope } from "../../routekit-eval-directory.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { writeProgressNotice } from "../dev/progress-notice.ts";
import { startCallbackServer } from "./callback-server.ts";
import {
  hasAmbientGatewayKey,
  hasGatewayKeyInEnv,
  hasResolvableGatewayCredential,
  environmentGatewayAuthSource,
  loadStoredGatewayKeyIntoEnvFrom,
  restoreDotenvGatewayCredentialAtStartup,
  resolveGatewayAuthSource,
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
import { resolveStartDir } from "../../routekit-eval-directory.ts";

const LOGIN_CALLBACK_TIMEOUT_MS = 300_000;

interface RunLoginOptions {
  readonly callbackPort?: number | undefined;
  readonly noBrowser: boolean;
  readonly scope: AuthStorageScope;
  /** Overrides the workspace search start directory; primarily a test seam. */
  readonly startDir?: string;
}

interface EnsureGatewayKeyOptions {
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
              "Timed out waiting for Gateway authorization. Run `routekit-eval login` again when ready.",
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

const ensureGatewayKeyIntoEnv = Effect.fn("Login.ensureGatewayKey")(
  function* (options: EnsureGatewayKeyOptions = {}) {
    const startDir = yield* resolveStartDir(options.startDir);

    yield* loadStoredGatewayKeyIntoEnvFrom({
      startDir,
    });
    if (yield* hasGatewayKeyInEnv()) {
      return;
    }

    yield* runLogin({
      callbackPort: options.callbackPort,
      noBrowser: options.noBrowser ?? false,
      scope: options.scope ?? "workspace-preferred",
      startDir,
    });
    yield* loadStoredGatewayKeyIntoEnvFrom({
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
   * diagnostic ("Run `routekit-eval login` before `routekit-eval <command>`"). Pass it when the
   * gate guards a specific command, so a non-interactive failure points at the
   * command the user actually ran.
   *
   * Omit it when there is no next command to name. `routekit-eval init` scaffolds a
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
   * When true, prefer the workspace-local run credential `.routekit-eval/start.json` over
   * `.routekit-eval/credentials.json` (used by `routekit-eval start`, RFC 0004 start.md). Only
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
}): ReturnType<typeof loadStoredGatewayKeyIntoEnvFrom> =>
  loadStoredGatewayKeyIntoEnvFrom(
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
 * Resolve a credential for the default `routekit-eval dev` / `routekit-eval start` gate: prefer the
 * workspace-local `.routekit-eval/credentials.json` (overriding any inherited env key so
 * the workspace stays pinned to its own credential — ROUTEKIT_EVAL-94), and otherwise
 * fall back to a *genuinely inherited* `ROUTEKIT_EVAL_BEARER_TOKEN`.
 *
 * Crucially, the fallback consults {@link hasAmbientGatewayKey} — the
 * snapshot of the env key taken at CLI startup *before* the bootstrap pre-loads
 * any stored credential — NOT the live env. The bootstrap (`routekit-eval.ts`) loads the
 * global `~/.routekit-eval/credentials.json` into the same process env for every command,
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
  if (yield* hasAmbientGatewayKey()) {
    return Option.some(environmentGatewayAuthSource);
  }
  return Option.none<GatewayAuthSource>();
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
      : yield* restoreDotenvGatewayCredentialAtStartup(input.startDir);
  }

  if (input.mode === "workspace-with-global-fallback") {
    const workspaceOrEnvCredential =
      yield* loadWorkspaceOrEnvCredentialIntoEnv(input);
    if (Option.isSome(workspaceOrEnvCredential)) {
      return workspaceOrEnvCredential;
    }
    const globalCredential = yield* loadStoredGatewayKeyIntoEnvFrom(
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
      : yield* restoreDotenvGatewayCredentialAtStartup(input.startDir);
  }

  const existingSource = yield* resolveGatewayAuthSource(input.startDir);
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
    : Option.none<GatewayAuthSource>();
  if (Option.isSome(projectCredential)) {
    return projectCredential;
  }
  const hasCredential = yield* hasResolvableGatewayCredential({
    startDir: input.startDir,
  });
  if (hasCredential) {
    return yield* loadStoredGatewayKeyIntoEnvFrom({
      startDir: input.startDir,
    });
  }
  return Option.isSome(existingSource)
    ? existingSource
    : yield* restoreDotenvGatewayCredentialAtStartup(input.startDir);
});

const loadCredentialIntoEnvForMode = (input: {
  readonly mode: NonNullable<EnsureCredentialOptions["mode"]>;
  readonly preferRunCredential?: boolean;
  readonly startDir: string;
}): ReturnType<typeof loadStoredGatewayKeyIntoEnvFrom> => {
  if (
    input.mode === "workspace" ||
    input.mode === "workspace-with-global-fallback"
  ) {
    return loadWorkspaceCredentialIntoEnv(input);
  }
  return loadStoredGatewayKeyIntoEnvFrom({
    startDir: input.startDir,
  });
};

/**
 * The "not signed in" diagnostic. With a `commandName` it points at that command,
 * which is what a caller guarding one wants. Without one it names the condition
 * a credential is needed for instead of a command, so a caller that does not know
 * what runs next (`routekit-eval init`) never sends a reader somewhere it made up.
 */
const missingCredentialMessage = (
  mode: NonNullable<EnsureCredentialOptions["mode"]>,
  commandName: string | undefined
): string => {
  const workspaceScoped =
    mode === "workspace" || mode === "workspace-with-global-fallback";
  if (commandName === undefined) {
    return workspaceScoped
      ? "\nYou're not signed in to Gateway for this RouteKitEval workspace yet. Run `routekit-eval login --local` before anything that calls a model.\n"
      : "\nYou're not signed in to Gateway yet. Run `routekit-eval login` before anything that calls a model.\n";
  }
  return workspaceScoped
    ? `\nYou're not signed in to Gateway for this RouteKitEval workspace yet. Run \`routekit-eval login --local\` before \`routekit-eval ${commandName}\`, or pass \`routekit-eval ${commandName} --global-auth\` to allow global auth for this session.\n`
    : `\nYou're not signed in to Gateway yet. Run \`routekit-eval login\` before \`routekit-eval ${commandName}\`.\n`;
};

/**
 * Shared onboarding credential gate (ROUTEKIT_EVAL-20): commands that need an Gateway
 * key (`routekit-eval init`, `routekit-eval dev`) call this before doing work that would otherwise
 * fail later with a confusing auth error.
 *
 * The default mode accepts any resolvable credential for onboarding commands.
 * Workspace mode is stricter for `routekit-eval dev`: it requires local workspace auth,
 * runs interactive login into that workspace, and can fail non-interactive runs
 * before the runtime starts.
 */
export const ensureGatewayCredential = Effect.fn("Login.ensureCredential")(
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
      return Option.none<GatewayAuthSource>();
    }

    yield* writeProgressNotice(
      "\nYou're not signed in to Gateway yet. Let's fix that...\n"
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

export { announceAuthorization, runLogin, ensureGatewayKeyIntoEnv };
export type {
  RunLoginOptions,
  EnsureGatewayKeyOptions,
  AnnounceAuthorizationInput,
  EnsureCredentialOptions,
};
