import { Effect, FileSystem, Option, Path, Result } from "effect";

import type { ModelSlug } from "../../../../contracts/internal/src/author-schemas/model.ts";
import type {
  ImportedModelContributions,
  ImportedPromptContributions,
} from "../feature-boot/contributions.ts";

import { decodeRootPersonaFrontmatter } from "../../../../contracts/internal/src/author-schemas/root-persona.ts";
import { BuiltinName } from "../../../../contracts/internal/src/builtin-name.ts";
import { makeImportBootDiagnostics } from "../feature-boot/diagnostic-record.ts";
import { parseMarkdownFrontmatter } from "../../../../utils/core/src/markdown-frontmatter.ts";

const ROOT_PERSONA_FILE = "routekit-eval.md";

// Contains a "/", which a real `features/*` directory id never can, so it
// cannot collide with a feature.
const ROOT_PERSONA_FEATURE_ID = "@routekit-eval/root";

// The root persona's prompt fragment leads the assembled system prompt: feature
// `prompt.md` entries default to order 0, so a strongly negative order keeps the
// workspace's base persona first unless the author sets an explicit `order`.
const ROOT_PERSONA_PROMPT_ORDER = -1000;

interface ImportedRootPersonaContributions {
  readonly modelProviders: ImportedModelContributions;
  readonly preferredHarnessName?: string | undefined;
  readonly prompts: ImportedPromptContributions;
}

const emptyRootPersona = (): ImportedRootPersonaContributions => ({
  modelProviders: {
    diagnostics: [],
    entries: [],
    records: [],
  },
  prompts: {
    diagnostics: [],
    entries: [],
    records: [],
  },
});

const promptDiagnosticsOnly = (
  messages: readonly string[]
): ImportedRootPersonaContributions => ({
  modelProviders: {
    diagnostics: [],
    entries: [],
    records: [],
  },
  prompts: {
    diagnostics: makeImportBootDiagnostics("prompt", messages),
    entries: [],
    records: [],
  },
});

const buildPromptContributions = (input: {
  readonly absolute: string;
  readonly body: string;
  readonly frontmatter: {
    readonly name?: string | undefined;
    readonly order?: number | undefined;
    readonly section?: string | undefined;
  };
}): ImportedPromptContributions => {
  const entry = {
    name: input.frontmatter.name ?? ROOT_PERSONA_FEATURE_ID,
    order: input.frontmatter.order ?? ROOT_PERSONA_PROMPT_ORDER,
    section: input.frontmatter.section,
    text: input.body,
    type: "static" as const,
  };

  return {
    diagnostics: [],
    entries: [entry],
    records: [
      {
        entry,
        featureId: ROOT_PERSONA_FEATURE_ID,
        kind: "prompt",
        origin: "project",
        shadows: false,
        sourcePath: input.absolute,
      },
    ],
  };
};

const buildModelContributions = (
  model: ModelSlug | undefined,
  absolute: string
): ImportedModelContributions => {
  if (model === undefined) {
    return {
      diagnostics: [],
      entries: [],
      records: [],
    };
  }

  // Register under BuiltinName.Model: the model registry only ever selects the
  // entry named "model" (RFC 0002 root-persona.md), and `shadows: true` lets it override the
  // built-in default. Features never contribute model entries, so this is the
  // single project-level source of the default model.
  const entry = {
    model,
    name: BuiltinName.Model,
  };
  return {
    diagnostics: [],
    entries: [entry],
    records: [
      {
        entry,
        featureId: ROOT_PERSONA_FEATURE_ID,
        kind: "model",
        origin: "project",
        shadows: true,
        sourcePath: absolute,
      },
    ],
  };
};

/**
 * Read the workspace-root `routekit-eval.md` and contribute (1) its markdown body as an
 * aggregate base prompt fragment and (2) its frontmatter `model` as a single
 * model entry named `BuiltinName.Model` (so the model registry selects it) that
 * shadows the built-in default. Returns empty record sets when `routekit-eval.md` is absent
 * — the no-op path that preserves today's behavior.
 */
export const importRootPersonaContributions = Effect.fn(
  "ContributionLoader.rootPersona"
)(function* (workspaceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(workspaceRoot, ROOT_PERSONA_FILE);

  const present = yield* fs
    .exists(absolute)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present) {
    return emptyRootPersona();
  }

  const content = yield* fs.readFileString(absolute).pipe(Effect.option);
  if (Option.isNone(content)) {
    return promptDiagnosticsOnly([
      `root persona "${ROOT_PERSONA_FILE}" could not be read`,
    ]);
  }

  const parsed = yield* parseMarkdownFrontmatter(content.value);
  const decoded = yield* decodeRootPersonaFrontmatter(parsed.frontmatter).pipe(
    Effect.result
  );
  if (Result.isFailure(decoded)) {
    return promptDiagnosticsOnly([
      ...parsed.diagnostics.map(
        (detail) => `root persona "${ROOT_PERSONA_FILE}" ${detail}`
      ),
      `root persona "${ROOT_PERSONA_FILE}" frontmatter is invalid: ${String(decoded.failure)}`,
    ]);
  }

  if (parsed.diagnostics.length > 0) {
    return promptDiagnosticsOnly(
      parsed.diagnostics.map(
        (detail) => `root persona "${ROOT_PERSONA_FILE}" ${detail}`
      )
    );
  }

  const frontmatter = decoded.success;
  return {
    modelProviders: buildModelContributions(frontmatter.model, absolute),
    preferredHarnessName: frontmatter.harness,
    // Trim the body so the frontmatter delimiter's surrounding newlines don't leak
    // into the composed system prompt (the root persona leads, joined by "\n\n").
    prompts: buildPromptContributions({
      absolute,
      body: parsed.body.trim(),
      frontmatter,
    }),
  } satisfies ImportedRootPersonaContributions;
});

export { ROOT_PERSONA_FILE, ROOT_PERSONA_FEATURE_ID };
export type { ImportedRootPersonaContributions };
