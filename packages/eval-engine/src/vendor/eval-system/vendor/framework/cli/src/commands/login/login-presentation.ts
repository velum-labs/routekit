import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Effect } from "effect";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type { CliIoError } from "../../../../contracts/internal/src/errors.ts";

import { openBrowser } from "./browser.ts";

export interface AnnounceAuthorizationInput {
  readonly authUrl: string;
  readonly cliIo: CliIo["Service"];
  readonly noBrowser: boolean;
}

/**
 * Print the authorization URL and, unless `--no-browser` was passed, open it in
 * the system browser. Splitting this out keeps the orchestrator linear and makes
 * both the print-only and browser-open paths directly testable.
 */
export const announceAuthorization = ({
  authUrl,
  cliIo,
  noBrowser,
}: AnnounceAuthorizationInput): Effect.Effect<
  void,
  CliIoError,
  ChildProcessSpawner
> => {
  if (noBrowser) {
    return cliIo.writeStdout(
      `Open this URL to sign in to Gateway:\n\n  ${authUrl}\n\nWaiting for you to finish in the browser...\n`
    );
  }
  return cliIo
    .writeStdout(
      `Opening your browser to sign in to Gateway...\nIf nothing opens, visit:\n\n  ${authUrl}\n\nWaiting for you to finish in the browser...\n`
    )
    .pipe(Effect.flatMap(() => openBrowser(authUrl)));
};

export const formatSuccess = (
  userId: string | null,
  savedPath: string
): string => {
  const who = userId === null ? "" : ` as ${userId}`;
  return `\nSigned in to Gateway${who}. API key saved to ${savedPath}.\nIf \`routekit-eval dev\` is already running, restart it to pick up the new key.\n`;
};
