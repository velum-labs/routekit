import { Effect } from "effect";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";

import { writeProgressNotice } from "../dev/progress-notice.ts";
import { ProjectInitError } from "./author-contracts.ts";

import { runBufferedCommand, writeCommandOutput } from "./command-output.ts";

const COMMAND_SUCCESS_EXIT_CODE = 0;

const INSTALL_FAILED_EXIT_CODE = 1;

/**
 * `npm install --ignore-scripts` for a scaffolded or synced workspace,
 * reporting whether it ran to completion. Shared by both init paths, which
 * differ only in whether a failure is fatal.
 */
export const runInstallStep = Effect.fn("ProjectInit.installStep")(
  function* (input: {
    readonly cliIo: CliIo["Service"];
    readonly failOnInstallError?: boolean;
    readonly install: boolean;
    readonly name: string;
    readonly projectRoot: string;
  }) {
    if (!input.install) {
      return false;
    }

    yield* writeProgressNotice("\nInstalling dependencies...\n");
    const result = yield* runBufferedCommand(input.projectRoot, "npm", [
      "install",
      "--ignore-scripts",
    ]);
    if (result.exitCode === COMMAND_SUCCESS_EXIT_CODE) {
      return true;
    }

    if (input.failOnInstallError) {
      yield* writeCommandOutput(input.cliIo, result.output);
      return yield* new ProjectInitError({
        detail: `\`npm install\` failed (exit code ${result.exitCode}) in ${input.projectRoot}.`,
        exitCode: INSTALL_FAILED_EXIT_CODE,
        operation: "installing dependencies",
      });
    }

    yield* input.cliIo.writeStderr(
      `\nInstall failed (exit code ${result.exitCode}). Run \`cd ${input.name} && npm install --ignore-scripts\` before \`routekit-eval dev\`.\n`
    );
    yield* writeCommandOutput(input.cliIo, result.output);
    return false;
  }
);
