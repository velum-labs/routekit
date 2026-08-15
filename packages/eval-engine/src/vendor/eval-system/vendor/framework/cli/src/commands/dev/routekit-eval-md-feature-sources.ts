import { Effect, FileSystem, Option, Path, Result } from "effect";

import { decodeRootPersonaFrontmatter } from "../../../../contracts/internal/src/author-schemas/root-persona.ts";
import { parseMarkdownFrontmatter } from "../../../../utils/core/src/markdown-frontmatter.ts";

const ROOT_PERSONA_FILE = "routekit-eval.md";

/**
 * Read the workspace-root `routekit-eval.md`'s `features:` array — the additional feature
 * sources (local dirs or `github.com/<owner>/<repo>[/path][@ref]` remote paths)
 * to compose with the workspace's own `features/` at boot.
 *
 * This is the CLI-layer counterpart to `importRootPersonaContributions` (which
 * runs inside boot and reads the persona's prompt/model/harness). Feature-source
 * composition must happen BEFORE boot — the composed root is what boot is pointed
 * at — and the composition machinery (`composeFeatureRoots`, remote fetch) lives
 * at this CLI layer, which the runloop cannot depend on. So the `features:` key
 * is read here, separately, and fed into the same composition as `--features`.
 *
 * Best-effort: a missing `routekit-eval.md`, an unreadable file, or invalid frontmatter
 * yields `[]` rather than failing feature resolution — the persona importer
 * surfaces the authoritative frontmatter diagnostic at boot. Returns the sources
 * in declared order.
 */
export const readRouteKitEvalMdFeatureSources = Effect.fn(
  "DevCommand.routeKitEvalMdFeatureSources"
)(function* (workspaceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(workspaceRoot, ROOT_PERSONA_FILE);

  const present = yield* fs
    .exists(absolute)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present) {
    return [];
  }

  const content = yield* fs.readFileString(absolute).pipe(Effect.option);
  if (Option.isNone(content)) {
    return [];
  }

  const parsed = yield* parseMarkdownFrontmatter(content.value).pipe(
    Effect.option
  );
  if (Option.isNone(parsed)) {
    return [];
  }

  const decoded = yield* decodeRootPersonaFrontmatter(
    parsed.value.frontmatter
  ).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    // Invalid frontmatter: don't compose anything from it here; the persona
    // importer reports the real diagnostic when boot reads the same file.
    return [];
  }

  return decoded.success.features ?? [];
});
