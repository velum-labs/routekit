import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Result } from "effect";

import type { ChatSuggestion } from "./vendor/framework/contracts/author/src/chat.ts";
import type { SkillRegistryEntry } from "./vendor/framework/contracts/internal/src/author-schemas/skill.ts";

import { readTextAsset } from "./runtime/text-asset.ts";
import {
  commandAliasesFromMetadata,
  decodeSkillFrontmatter,
} from "./vendor/framework/contracts/internal/src/author-schemas/skill.ts";
import { RuntimeServerError } from "./vendor/framework/contracts/internal/src/errors.ts";
import {
  resolveSkillSourceDir,
  textImport,
} from "./vendor/framework/runloop/local/src/skills/skill-materialization.ts";
import { parseMarkdownFrontmatter } from "./vendor/framework/utils/core/src/markdown-frontmatter.ts";

const createEvalSkillMarkdown = readTextAsset(
  import.meta.url,
  "../skills/create-eval.SKILL.md",
);

const CREATE_EVAL_SKILL_NAME = "create-eval";
const EVAL_SYSTEM_CODE_FEATURE_ID = "eval-system-code";
const CREATE_EVAL_SOURCE_PATH = "skills/create-eval/SKILL.md";
const CREATE_EVAL_CACHE_PREFIX = "eval-system-create-eval";

type DecodedFrontmatter = Effect.Success<ReturnType<typeof decodeSkillFrontmatter>>;
type RequiredFrontmatter = DecodedFrontmatter & {
  readonly description: string;
  readonly name: string;
};

const decodeCreateEval = Effect.fn("EvalSystem.decodeCreateEval")(function* () {
  const parsed = yield* parseMarkdownFrontmatter(createEvalSkillMarkdown);
  const decoded = yield* decodeSkillFrontmatter(parsed.frontmatter).pipe(Effect.result);
  if (parsed.diagnostics.length > 0 || Result.isFailure(decoded)) {
    return yield* new RuntimeServerError({
      detail:
        parsed.diagnostics.join("\n") ||
        (Result.isFailure(decoded)
          ? String(decoded.failure)
          : "create-eval did not produce frontmatter"),
      operation: "loading create-eval",
    });
  }
  const frontmatter = decoded.success;
  if (frontmatter.name === undefined || frontmatter.description === undefined) {
    return yield* new RuntimeServerError({
      detail: "create-eval is missing its name or description",
      operation: "loading create-eval",
    });
  }
  return {
    body: parsed.body,
    frontmatter: {
      ...frontmatter,
      description: frontmatter.description,
      name: frontmatter.name,
    } satisfies RequiredFrontmatter,
  };
});

const resolveCreateEvalSourceRoot = Effect.fn("EvalSystem.resolveCreateEvalSourceRoot")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* resolveSkillSourceDir(fs, path, {
      cachePrefix: CREATE_EVAL_CACHE_PREFIX,
      files: [[CREATE_EVAL_SOURCE_PATH, textImport(createEvalSkillMarkdown)]] as const,
      probeRelativePath: CREATE_EVAL_SOURCE_PATH,
      sourceTreeDir: undefined,
    });
  },
  Effect.provide(NodeServicesLayer),
);

const resolveCreateEvalSkillEntries = Effect.fn("EvalSystem.resolveCreateEvalSkillEntries")(
  function* (excludedNames: ReadonlySet<string>) {
    if (excludedNames.has(CREATE_EVAL_SKILL_NAME)) return [];
    const path = yield* Path.Path;
    const sourceRoot = yield* resolveCreateEvalSourceRoot();
    const { body, frontmatter } = yield* decodeCreateEval();
    const commandAliases = commandAliasesFromMetadata(frontmatter.metadata);
    return [
      {
        ...frontmatter,
        body,
        ...(commandAliases.length === 0 ? {} : { commandAliases }),
        description: frontmatter.description,
        featureId: EVAL_SYSTEM_CODE_FEATURE_ID,
        name: frontmatter.name,
        sourceDir: path.dirname(path.join(sourceRoot, CREATE_EVAL_SOURCE_PATH)),
        sourcePath: CREATE_EVAL_SOURCE_PATH,
      } satisfies SkillRegistryEntry,
    ];
  },
  Effect.provide(NodeServicesLayer),
);

const resolveCreateEvalSuggestion = Effect.fn("EvalSystem.resolveCreateEvalSuggestion")(
  function* () {
    const { frontmatter } = yield* decodeCreateEval();
    const aliases = commandAliasesFromMetadata(frontmatter.metadata);
    return {
      ...(aliases.length === 0 ? {} : { aliases }),
      description: frontmatter.description,
      name: frontmatter.name,
    } satisfies ChatSuggestion;
  },
);

export {
  CREATE_EVAL_SKILL_NAME,
  EVAL_SYSTEM_CODE_FEATURE_ID,
  resolveCreateEvalSkillEntries,
  resolveCreateEvalSuggestion,
};
