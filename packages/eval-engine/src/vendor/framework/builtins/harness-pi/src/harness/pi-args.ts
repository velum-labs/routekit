import type { HarnessInvokeOptions } from "../../../ori/src/index.ts";

import { join } from "node:path";

import {
  PI_FALLBACK_DEFAULT_MODEL,
  resolvePiModel,
} from "../model/model.ts";

import type { PiPromptFiles } from "./prompt-files.ts";

const AGENTS_SKILL_ROOT = ".agents/skills";
const APPEND_SYSTEM_PROMPT_FLAG = "--append-system-prompt";
const JSON_MODE = "json";
const MODEL_FLAG = "--model";
const PI_MODE_FLAG = "--mode";
const PRINT_FLAG = "--print";
const SESSION_ID_FLAG = "--session-id";
const SKILL_FLAG = "--skill";
const SYSTEM_PROMPT_FLAG = "--system-prompt";
const EXTENSION_FLAG = "--extension";

interface PiArgsConfig {
  readonly defaultModel?: string | undefined;
  readonly extraArgs?: readonly string[] | undefined;
}

const buildPiArgs = (
  options: HarnessInvokeOptions,
  config: PiArgsConfig = {},
  injected: {
    readonly mcpExtensionPath?: string | undefined;
    readonly openRouterSessionAttributionExtensionPath?: string | undefined;
    readonly promptFiles?: PiPromptFiles | undefined;
    readonly webToolsExtensionPath?: string | undefined;
  } = {}
): readonly string[] => {
  // pi accepts repeated `--extension` (each pushed onto an array), so the
  // web-tools and MCP bridges load side by side; omit a flag whose path is unset.
  const extensionArgs = [
    injected.webToolsExtensionPath,
    injected.mcpExtensionPath,
    injected.openRouterSessionAttributionExtensionPath,
  ].flatMap((path) => (path === undefined ? [] : [EXTENSION_FLAG, path]));
  const args = [
    PRINT_FLAG,
    PI_MODE_FLAG,
    JSON_MODE,
    ...extensionArgs,
    ...(config.extraArgs ?? []),
  ];

  if (options.cwd) {
    args.push(SKILL_FLAG, join(options.cwd, AGENTS_SKILL_ROOT));
  }

  // A framework-owned skill directory (RFC 0004 code.md): `ori code`'s
  // built-in code-practice skills load this way instead of being
  // materialized into the project's own `.agents/skills`. Additive to the
  // cwd-based `--skill` above; pi merges skills from every `--skill` flag.
  for (const extraSkillDir of options.extraSkillDirs ?? []) {
    args.push(SKILL_FLAG, extraSkillDir);
  }

  if (options.sessionId) {
    args.push(SESSION_ID_FLAG, options.sessionId);
  }

  if (injected.promptFiles?.systemPromptPath !== undefined) {
    args.push(SYSTEM_PROMPT_FLAG, injected.promptFiles.systemPromptPath);
  }

  if (injected.promptFiles?.appendSystemPromptPath !== undefined) {
    args.push(
      APPEND_SYSTEM_PROMPT_FLAG,
      injected.promptFiles.appendSystemPromptPath
    );
  }

  // Always emit `--model` (see model.ts / RFC 0006 rule 4): the caller's model
  // when non-blank, otherwise the configured default, always openrouter/-forced.
  args.push(
    MODEL_FLAG,
    resolvePiModel(
      options.model,
      config.defaultModel ?? PI_FALLBACK_DEFAULT_MODEL
    )
  );

  return args;
};

export { buildPiArgs };
export type { PiArgsConfig };
