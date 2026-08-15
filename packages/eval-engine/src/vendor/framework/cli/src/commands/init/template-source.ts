import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import { ROOT_PERSONA_FILE } from "../../../../runloop/local/src/contributions/root-persona.ts";
import {
  AUTHOR_CONTRACTS_PACKAGE,
  AUTHOR_CONTRACTS_PACKAGE_VERSION,
} from "../author-contracts-package.ts";
import {
  ProjectInitError,
  syncAuthorContracts,
} from "./author-contracts.ts";
import { readVersionInfo } from "../version/version-info.ts";
import { ORI_GITIGNORE_ENTRY } from "../../ori-directory.ts";
import { upsertMarkdownFrontmatter } from "../../../../utils/core/src/markdown-frontmatter.ts";

import {
  downloadTemplatesArchive,
  readOptionalEnv,
  TEMPLATE_RESOLVE_EXIT_CODE,
} from "./template-archive.ts";

/** The baseline template; what a plain `ori init` (no `--template`) scaffolds. */
const DEFAULT_TEMPLATE = "default";

/** Point at a local checkout of the templates repository, skipping the download. */
const TEMPLATES_DIR_ENV = "ORI_TEMPLATES_DIR";

// Template names map directly to a directory in the templates repository, so
// constrain them to a single safe path segment to rule out traversal (`../`).
const TEMPLATE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const JSON_INDENT = 2;

// package.json is our own template content, but decode it through a schema
// instead of trusting a raw cast so a malformed file fails loudly at the boundary.
const PackageJsonSchema = Schema.Record(Schema.String, Schema.Unknown);

// Entries the committed templates omit (they ship only the build-output
// ignores). `ORI_GITIGNORE_ENTRY` (`.ori/`) keeps the injected author-contracts
// cache out of version control.
const INJECTED_GITIGNORE_ENTRIES = [
  ".env",
  ".env.*",
  "!.env.example",
  ".agents/skills/",
  ".claude/skills/",
  ORI_GITIGNORE_ENTRY,
] as const;

interface MaterializeTemplateOptions {
  /** Template (directory) name to resolve from the templates repository. */
  readonly template: string;
  /** Absolute path of the workspace directory to create. */
  readonly targetDir: string;
  /** Normalized workspace name written into the copied root package.json. */
  readonly workspaceName: string;
}

// Provenance only — the runtime never reads the stamped `version`. Best-effort
// and idempotent: a template without an `ori.md`, or a version that cannot be
// resolved, skips the stamp rather than failing an otherwise-good scaffold.
const stampVersion = Effect.fn("ProjectInit.stampVersion")(function* (
  targetDir: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const personaPath = path.join(targetDir, ROOT_PERSONA_FILE);

  const existing = yield* fs.readFileString(personaPath).pipe(Effect.option);
  if (Option.isNone(existing)) {
    return;
  }

  const versionInfo = yield* readVersionInfo.pipe(Effect.option);
  const version = Option.isSome(versionInfo)
    ? versionInfo.value.version.trim()
    : "";
  if (version === "") {
    return;
  }

  yield* fs.writeFileString(
    personaPath,
    upsertMarkdownFrontmatter(existing.value, { version })
  );
});

const resolveTemplatesRoot = Effect.fn("ProjectInit.resolveTemplatesRoot")(
  function* () {
    const localDir = yield* readOptionalEnv(TEMPLATES_DIR_ENV);
    if (localDir !== undefined) {
      return localDir;
    }
    return yield* downloadTemplatesArchive();
  }
);

const listTemplates = Effect.fn("ProjectInit.listTemplates")(function* (
  root: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  const named = yield* Effect.forEach([...entries].toSorted(), (entry) =>
    fs.exists(path.join(root, entry, "package.json")).pipe(
      // A regular file at the root (e.g. `.gitignore`) makes `<file>/package.json`
      // an ENOTDIR access error; treat any such entry as simply not a template.
      Effect.orElseSucceed(() => false),
      Effect.map((hasPackageJson) => (hasPackageJson ? entry : undefined))
    )
  );
  return named.filter((entry): entry is string => entry !== undefined);
});

const assertTemplateExists = Effect.fn("ProjectInit.assertTemplateExists")(
  function* (input: {
    readonly root: string;
    readonly template: string;
    readonly templatePath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const isTemplate = yield* fs
      .exists(path.join(input.templatePath, "package.json"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isTemplate) {
      return;
    }

    const available = yield* listTemplates(input.root);
    const detail =
      available.length === 0
        ? `Template "${input.template}" was not found, and no templates are available in the source.`
        : `Template "${input.template}" was not found. Available templates: ${available.join(", ")}.`;
    return yield* new ProjectInitError({
      detail,
      exitCode: TEMPLATE_RESOLVE_EXIT_CODE,
      operation: "resolving the template",
    });
  }
);

const rewriteRootPackageJson = Effect.fn("ProjectInit.rewriteRootPackageJson")(
  function* (targetDir: string, workspaceName: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageJsonPath = path.join(targetDir, "package.json");
    const raw = yield* fs.readFileString(packageJsonPath);
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PackageJsonSchema)
    )(raw).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectInitError({
            detail: `Template package.json is not valid JSON: ${String(cause)}`,
            exitCode: TEMPLATE_RESOLVE_EXIT_CODE,
            operation: "preparing the template",
          })
      )
    );
    const existingDependencies =
      typeof decoded.dependencies === "object" && decoded.dependencies !== null
        ? decoded.dependencies
        : {};
    const updated = {
      ...decoded,
      dependencies: {
        ...existingDependencies,
        // The scaffolded project declares ONLY `ori` (`file:.ori/sdk`). `effect` and
        // `@effect/platform-node` are NOT direct project dependencies — they are
        // transitive deps of the `.ori/sdk` package (declared in its own
        // package.json, see author-contracts.ts) and resolve through it. A feature
        // author imports every runtime value (Schema, the harness plumbing, …) from
        // `ori`, never from `effect` directly, so `effect` must not appear in the
        // author's project manifest.
        [AUTHOR_CONTRACTS_PACKAGE]: AUTHOR_CONTRACTS_PACKAGE_VERSION,
      },
      name: workspaceName,
    };
    const serialized = yield* encodeJsonString(
      PackageJsonSchema,
      JSON_INDENT
    )(updated);
    yield* fs.writeFileString(packageJsonPath, `${serialized}\n`);
  }
);

// Only missing lines are added, so a re-run never duplicates an entry. Exported
// so the existing-workspace sync path (`ori init .`) can keep `.gitignore`
// correct after materializing `.ori/sdk`, matching what the create path does.
export const ensureGitignoreEntries = Effect.fn(
  "ProjectInit.ensureGitignoreEntries"
)(function* (targetDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitignorePath = path.join(targetDir, ".gitignore");
  const existing = yield* fs
    .readFileString(gitignorePath)
    .pipe(Effect.orElseSucceed(() => ""));
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = INJECTED_GITIGNORE_ENTRIES.filter(
    (entry) => !present.has(entry)
  );
  if (missing.length === 0) {
    return;
  }

  const base = existing.trimEnd();
  const prefix = base === "" ? "" : `${base}\n`;
  yield* fs.writeFileString(gitignorePath, `${prefix}${missing.join("\n")}\n`);
});

/**
 * Copy a persona template from the templates repository into `targetDir`. The
 * source is a local checkout when `ORI_TEMPLATES_DIR` is set, otherwise the
 * public templates repository downloaded as a tarball into a scoped temp dir.
 * The caller owns the existence check on `targetDir` and cleanup on failure.
 *
 * After copying, the template is turned into a ready-to-edit Ori workspace: the
 * root package.json is renamed and gains the `ori` author-contracts dependency,
 * the `.ori/sdk` author-contracts cache is written, and the `.ori/` (plus env and
 * agent-skill) entries are appended to `.gitignore`. The templates themselves stay
 * dependency-free so the templates repo's own CI can install each one — the SDK
 * wiring lives here, injected at scaffold time.
 */
export const materializeTemplate = Effect.fn("ProjectInit.materializeTemplate")(
  function* (options: MaterializeTemplateOptions) {
    if (!TEMPLATE_NAME_PATTERN.test(options.template)) {
      return yield* new ProjectInitError({
        detail: `Invalid template name "${options.template}". Use a name like "code-review".`,
        exitCode: TEMPLATE_RESOLVE_EXIT_CODE,
        operation: "resolving the template",
      });
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* resolveTemplatesRoot();
        const templatePath = path.join(root, options.template);
        yield* assertTemplateExists({
          root,
          template: options.template,
          templatePath,
        });
        yield* fs.makeDirectory(path.dirname(options.targetDir), {
          recursive: true,
        });
        yield* fs.copy(templatePath, options.targetDir);
        yield* rewriteRootPackageJson(options.targetDir, options.workspaceName);
        yield* stampVersion(options.targetDir);
        yield* syncAuthorContracts(options.targetDir);
        yield* ensureGitignoreEntries(options.targetDir);
      })
    );
  }
);

export { DEFAULT_TEMPLATE, TEMPLATES_DIR_ENV };
export type { MaterializeTemplateOptions };
