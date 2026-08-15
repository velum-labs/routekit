import type { Path } from "effect";

import { Effect } from "effect";

import type { DataContributionFile } from "../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import type {
  FeatureLocation,
  LoaderContext,
  Resolved,
} from "./feature-loader-resolution.ts";
import type { ResolvedContribution } from "./feature-loader-types.ts";

import { FeaturePathEscapeDiagnostic } from "./feature-loader-diagnostics.ts";

export const dataContribution = (
  contribution: DataContributionFile
): ResolvedContribution => ({
  entryKey: contribution.entryKey,
  file: contribution.file,
  kind: contribution.kind,
});

const makeEscapeResult = (
  featureId: string,
  candidate: string
): Resolved<"escapes"> => ({
  diagnostics: [
    new FeaturePathEscapeDiagnostic({
      candidate,
      featureId,
    }),
  ],
  value: "escapes",
});

/**
 * Lexical containment gate: resolves `.`/`..` segments without touching the
 * filesystem. Returns true when the candidate escapes the feature directory,
 * including the empty / `"."` candidate which resolves to the directory itself
 * (never a valid contribution file).
 */
const escapesLexically = (
  path: Path.Path,
  featureDir: string,
  candidate: string
): boolean => {
  const resolvedDir = path.resolve(featureDir);
  const resolvedCandidate = path.resolve(featureDir, candidate);
  return !resolvedCandidate.startsWith(`${resolvedDir}${path.sep}`);
};

/**
 * Symlink-aware containment gate: resolves both the feature directory and the
 * candidate via `realPath` (following symlinks) and returns true when the real
 * candidate path escapes the real feature directory. Closes the hole where a
 * symlink inside the feature dir points outside it.
 */
const escapesViaSymlink = Effect.fn("FeatureLoader.escapesViaSymlink")(
  function* (ctx: LoaderContext, featureDir: string, target: string) {
    const resolvedDir = yield* ctx.fs
      .realPath(featureDir)
      .pipe(Effect.orElseSucceed(() => ctx.path.resolve(featureDir)));
    const resolvedTarget = yield* ctx.fs
      .realPath(target)
      .pipe(Effect.orElseSucceed(() => ctx.path.resolve(target)));
    return !resolvedTarget.startsWith(`${resolvedDir}${ctx.path.sep}`);
  }
);

/**
 * Classify a single candidate path. Returns a resolution status with diagnostics
 * — `"escapes"` when the path leaves the feature directory lexically (`..`) or
 * via a symlink. The symlink check runs only when the candidate exists.
 */
export const resolveContribution = Effect.fn(
  "FeatureLoader.resolveContribution"
)(function* (ctx: LoaderContext, location: FeatureLocation, candidate: string) {
  const { featureDir, featureId } = location;
  if (escapesLexically(ctx.path, featureDir, candidate)) {
    return makeEscapeResult(featureId, candidate);
  }
  const target = ctx.path.join(featureDir, candidate);
  const present = yield* ctx.fs
    .exists(target)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present) {
    return {
      diagnostics: [],
      value: "absent" as const,
    };
  }
  if (yield* escapesViaSymlink(ctx, featureDir, target)) {
    return makeEscapeResult(featureId, candidate);
  }
  return {
    diagnostics: [],
    value: "present" as const,
  };
});
