import { Effect, Option } from "effect";

import type { OpenRouterAuthSource } from "../../../../contracts/internal/src/openrouter-auth.ts";
import type { WorkspaceCredentialChoice } from "../login/credentials-choice.ts";

import { formatSuccess } from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import {
  environmentOpenRouterAuthSource,
  hasAmbientOpenRouterKey,
  projectOpenRouterAuthSourceAtStartup,
  resolveOpenRouterAuthSource,
} from "../login/credentials.ts";
import { readWorkspaceCredentialChoice } from "../login/credentials-choice.ts";
import { resolveStoredCredential } from "../login/credentials-resolve.ts";
import { OriDirectory, resolveStartDir } from "../../ori-directory.ts";

/**
 * What `ori auth` resolved for one directory: the credential that would be used
 * from there, the workspace root the cascade searched from, and the OpenRouter
 * user the credential belongs to when the stored file records one.
 */
interface AuthStatus {
  readonly authenticated: boolean;
  readonly source: OpenRouterAuthSource | null;
  readonly startDir: string;
  readonly userId: string | null;
  readonly workspaceChoice: WorkspaceCredentialChoice["choice"] | null;
  readonly workspaceRoot: string | null;
}

/**
 * Resolve the credential that a command run from `startDir` would use, in the
 * same precedence as the startup loader (RFC 0004 login.md): a genuinely
 * inherited `OPENROUTER_API_KEY`, then the workspace-local
 * `.ori/credentials.json`, then global credentials when global auth is in
 * play, then the project dotenv snapshot as a last resort.
 *
 * The ambient snapshot is what makes the environment branch honest: the CLI
 * bootstrap loads a stored key into the process env before any command runs, so
 * reading the env here would report every stored credential as an environment
 * one.
 */
const resolveAuthStatus = Effect.fn("AuthCommand.resolveStatus")(function* (
  startDirOverride?: string
) {
  const oriDirectory = yield* OriDirectory;
  const startDir = yield* resolveStartDir(startDirOverride);
  const workspaceRoot = yield* oriDirectory.workspaceRootFrom(startDir);
  const base = {
    startDir,
    workspaceChoice: Option.isSome(workspaceRoot)
      ? (Option.getOrNull(
          yield* readWorkspaceCredentialChoice(workspaceRoot.value)
        )?.choice ?? null)
      : null,
    workspaceRoot: Option.getOrNull(workspaceRoot),
  };

  if (yield* hasAmbientOpenRouterKey()) {
    return {
      ...base,
      authenticated: true,
      source: environmentOpenRouterAuthSource,
      userId: null,
    } satisfies AuthStatus;
  }

  const stored = yield* resolveStoredCredential({ startDir });
  const projectSource = yield* projectOpenRouterAuthSourceAtStartup();
  if (base.workspaceChoice === "project" && Option.isSome(projectSource)) {
    return {
      ...base,
      authenticated: true,
      source: projectSource.value,
      userId: null,
    } satisfies AuthStatus;
  }
  if (Option.isSome(stored)) {
    return {
      ...base,
      authenticated: true,
      source: stored.value.source,
      userId: stored.value.credentials.userId,
    } satisfies AuthStatus;
  }

  const resolvedSource = yield* resolveOpenRouterAuthSource(startDir);
  return Option.isSome(resolvedSource)
    ? {
        ...base,
        authenticated: true,
        source: resolvedSource.value,
        userId: null,
      }
    : {
        ...base,
        authenticated: false,
        source: null,
        userId: null,
      };
});

const describeSource = (source: OpenRouterAuthSource): string => {
  if (source.kind === "environment") {
    return `the ${source.location} environment variable`;
  }
  if (source.kind === "project") {
    return `the project dotenv file ${source.location}`;
  }
  return source.kind === "workspace"
    ? `the workspace credential ${source.location}`
    : `the global credential ${source.location}`;
};

const formatAuthenticatedText = (status: AuthStatus): string => {
  if (status.source === null) {
    return "";
  }
  const who = status.userId === null ? "" : ` as ${status.userId}`;
  const choice =
    status.workspaceChoice === null
      ? ""
      : ` Workspace choice: ${status.workspaceChoice === "project" ? "project dotenv credential" : "stored credential"}.`;
  return `${formatSuccess(
    `Authenticated with OpenRouter${who} via ${describeSource(status.source)}.`
  )}${choice}\n`;
};

const unauthenticatedFailure = (status: AuthStatus): CliFailureError =>
  new CliFailureError({
    detail: `Not authenticated with OpenRouter from ${status.startDir}.`,
    hint: "Run `ori login` to sign in, or export OPENROUTER_API_KEY.",
  });

export { formatAuthenticatedText, resolveAuthStatus, unauthenticatedFailure };
export type { AuthStatus };
