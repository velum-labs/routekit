import type { HarnessInvokeOptions } from "../../../ori/src/index.ts";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatOutputSchemaInstruction } from "../../../ori/src/process.ts";

const PI_PROMPT_FILE_DIR_PREFIX = "ori-pi-prompt-";
const SYSTEM_PROMPT_FILENAME = "system-prompt.md";
const APPEND_SYSTEM_PROMPT_FILENAME = "append-system-prompt.md";

interface PiPromptFiles {
  readonly appendSystemPromptPath?: string | undefined;
  readonly dir: string;
  readonly systemPromptPath?: string | undefined;
}

// pi resolves a `--system-prompt` / `--append-system-prompt` value that names
// an existing file to that file's contents, so large prompts ride the
// filesystem instead of argv — inline values E2BIG the spawn once the arg
// vector outgrows the OS limit.
const writePromptFileIfPresent = async (
  dir: string,
  filename: string,
  content: string | undefined
): Promise<string | undefined> => {
  if (content === undefined) {
    return undefined;
  }
  const path = join(dir, filename);
  await writeFile(path, content, "utf-8");
  return path;
};

const writePiPromptFiles = async (
  options: HarnessInvokeOptions
): Promise<PiPromptFiles | undefined> => {
  const systemPrompt =
    options.systemPrompt === undefined || options.systemPrompt === ""
      ? undefined
      : options.systemPrompt;
  const appendSystemPrompt =
    options.outputSchema === undefined
      ? undefined
      : formatOutputSchemaInstruction(options.outputSchema);
  if (systemPrompt === undefined && appendSystemPrompt === undefined) {
    return undefined;
  }

  const dir = await mkdtemp(join(tmpdir(), PI_PROMPT_FILE_DIR_PREFIX));
  return {
    appendSystemPromptPath: await writePromptFileIfPresent(
      dir,
      APPEND_SYSTEM_PROMPT_FILENAME,
      appendSystemPrompt
    ),
    dir,
    systemPromptPath: await writePromptFileIfPresent(
      dir,
      SYSTEM_PROMPT_FILENAME,
      systemPrompt
    ),
  };
};

const removePiPromptFiles = async (
  promptFiles: PiPromptFiles | undefined
): Promise<void> => {
  if (promptFiles === undefined) {
    return;
  }
  await rm(promptFiles.dir, {
    force: true,
    recursive: true,
  });
};

export { removePiPromptFiles, writePiPromptFiles };
export type { PiPromptFiles };
