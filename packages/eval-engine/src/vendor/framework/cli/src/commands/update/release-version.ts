import {
  Effect,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

const EQUAL_VERSION = 0;
const GREATER_VERSION = 1;
const LESSER_VERSION = -1;

/** The outcome of an `ori update --check`, rendered to stdout or `--json` output. */
const UpdateCheckResultSchema = Schema.Struct({
  currentVersion: Schema.NullOr(Schema.String),
  latestVersion: Schema.String,
  updateAvailable: Schema.Boolean,
}).annotate({ identifier: "UpdateCheckResult" });

type UpdateCheckResult = typeof UpdateCheckResultSchema.Type;

/**
 * How big a jump an available update is, relative to the installed release.
 * `none` means there is nothing newer to install. Drives the auto-updater's
 * threshold policy (see `auto-update.ts`): updates at or below the configured
 * level are applied automatically, anything above is held for approval.
 *
 * This is the single source for the severity literal set; `auto-update-state.ts`
 * reuses this schema for the persisted held-update record.
 */
const UpdateSeveritySchema = Schema.Literals([
  "none",
  "patch",
  "minor",
  "major",
]).annotate({ identifier: "UpdateSeverity" });

type UpdateSeverity = typeof UpdateSeveritySchema.Type;

const RELEASE_VERSION_PATTERN =
  /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?$/u;

/**
 * A SemVer core component (major/minor/patch). Decoding coerces the digit string
 * the pattern captured into a non-negative integer, so the numeric contract lives
 * in the schema rather than an imperative `Number.parseInt` + `Number.isInteger`
 * guard. `NumberFromString` rejects unsafe magnitudes, so a version whose core
 * overflows a safe integer fails to decode and reads as unparseable.
 */
const SemVerCoreNumberSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
).annotate({ identifier: "SemVerCoreNumber" });

/** One dot-separated SemVer prerelease identifier (never contains a `.`). */
const PrereleaseIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[0-9A-Za-z-]+$/u)
).annotate({ identifier: "PrereleaseIdentifier" });

/** SemVer build metadata (the `+<...>` suffix). */
const BuildMetadataSchema = Schema.String.check(
  Schema.isPattern(/^[0-9A-Za-z.-]+$/u)
).annotate({ identifier: "BuildMetadata" });

/**
 * The decoded fields of a release version. `build` (SemVer build metadata, the
 * `+<...>` suffix) is excluded from `compareReleaseVersions` precedence per
 * SemVer §10, but used by the update-decision layer as a tiebreak — see
 * `isNewerRelease`. This is the `Type` side of {@link ReleaseVersionFromString};
 * the codec below is the parse/format boundary.
 */
const ReleaseVersionFields = Schema.Struct({
  major: SemVerCoreNumberSchema,
  minor: SemVerCoreNumberSchema,
  patch: SemVerCoreNumberSchema,
  prerelease: Schema.Array(PrereleaseIdentifierSchema),
  build: Schema.UndefinedOr(BuildMetadataSchema),
}).annotate({ identifier: "ReleaseVersion" });

type ReleaseVersion = typeof ReleaseVersionFields.Type;
type ReleaseVersionEncoded = typeof ReleaseVersionFields.Encoded;

const notAReleaseVersion = (value: string): SchemaIssue.Issue =>
  new SchemaIssue.InvalidValue(
    { message: `Not a release version: ${value}` },
    value,
    { reportInput: true }
  );

/**
 * The single SemVer codec: a string decodes to {@link ReleaseVersion} and a
 * version encodes back to its canonical string. The transformation only bridges
 * the raw string and the struct's *encoded* shape (the regex split one way, the
 * `major.minor.patch-prerelease+build` join the other); the field schemas own
 * the numeric coercion and identifier validation. Owning both directions here
 * means the wire format lives in exactly one place — no hand-written renderer.
 */
const ReleaseVersionFromString = Schema.String.pipe(
  Schema.decodeTo(
    ReleaseVersionFields,
    SchemaTransformation.transformOrFail({
      decode: (value: string) => {
        const groups = RELEASE_VERSION_PATTERN.exec(value.trim())?.groups;
        // The core groups are mandatory `\d+`, so a matched pattern always
        // captures `major`; a non-match leaves `groups` undefined.
        if (groups?.major === undefined) {
          return Effect.fail(notAReleaseVersion(value));
        }
        const encoded: ReleaseVersionEncoded = {
          major: groups.major,
          minor: groups.minor ?? "",
          patch: groups.patch ?? "",
          prerelease:
            groups.prerelease === undefined ? [] : groups.prerelease.split("."),
          build: groups.build,
        };
        return Effect.succeed(encoded);
      },
      encode: (encoded: ReleaseVersionEncoded) => {
        const core = `${encoded.major}.${encoded.minor}.${encoded.patch}`;
        const prerelease =
          encoded.prerelease.length > 0
            ? `-${encoded.prerelease.join(".")}`
            : "";
        const build = encoded.build === undefined ? "" : `+${encoded.build}`;
        return Effect.succeed(`${core}${prerelease}${build}`);
      },
    })
  )
).annotate({ identifier: "ReleaseVersionFromString" });

const decodeReleaseVersion = Schema.decodeUnknownOption(
  ReleaseVersionFromString
);

const parseReleaseVersion = (value: string): ReleaseVersion | undefined =>
  Option.getOrUndefined(decodeReleaseVersion(value));

// A prerelease identifier that is a base-10 integer with no leading zeros. The
// pattern-then-coerce schema replaces the imperative `Number.parseInt` guard;
// decoding is `None` for a non-numeric or leading-zero identifier, which SemVer
// §11 orders below any numeric identifier.
const NumericPrereleaseIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d*)$/u)
).pipe(Schema.decodeTo(Schema.Number, SchemaTransformation.numberFromString));

const decodeNumericPrerelease = Schema.decodeUnknownOption(
  NumericPrereleaseIdentifierSchema
);

const numericPrereleasePart = (value: string): number | undefined =>
  Option.getOrUndefined(decodeNumericPrerelease(value));

const compareNumber = (left: number, right: number): -1 | 0 | 1 => {
  if (left > right) {
    return GREATER_VERSION;
  }
  if (left < right) {
    return LESSER_VERSION;
  }
  return EQUAL_VERSION;
};

const compareString = (left: string, right: string): -1 | 0 | 1 => {
  if (left > right) {
    return GREATER_VERSION;
  }
  if (left < right) {
    return LESSER_VERSION;
  }
  return EQUAL_VERSION;
};

const comparePrereleasePart = (left: string, right: string): -1 | 0 | 1 => {
  const leftNumber = numericPrereleasePart(left);
  const rightNumber = numericPrereleasePart(right);
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return compareNumber(leftNumber, rightNumber);
  }
  if (leftNumber !== undefined) {
    return LESSER_VERSION;
  }
  if (rightNumber !== undefined) {
    return GREATER_VERSION;
  }
  return compareString(left, right);
};

// SemVer §11: a version without prerelease parts outranks one with them; two
// releases (both empty) tie. Undefined when both sides have parts to compare.
const emptyPrereleaseOrdering = (
  left: readonly string[],
  right: readonly string[]
): -1 | 0 | 1 | undefined => {
  if (left.length === 0 && right.length === 0) {
    return EQUAL_VERSION;
  }
  if (left.length === 0) {
    return GREATER_VERSION;
  }
  if (right.length === 0) {
    return LESSER_VERSION;
  }
  return undefined;
};

const comparePrerelease = (
  left: readonly string[],
  right: readonly string[]
): -1 | 0 | 1 => {
  const emptyOrdering = emptyPrereleaseOrdering(left, right);
  if (emptyOrdering !== undefined) {
    return emptyOrdering;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // `index` runs up to the longer array's length, so an out-of-bounds access on
    // the shorter array is `undefined` at runtime. Bare index access is typed as
    // `string` (no `noUncheckedIndexedAccess`), which would make the guards below
    // look unnecessary; `.at()` is typed `string | undefined`, so it both reflects
    // the real optionality and keeps the load-bearing guards. Behavior is identical
    // for the non-negative in-range/out-of-range indices used here.
    const leftPart = left.at(index);
    const rightPart = right.at(index);
    if (leftPart === undefined) {
      return LESSER_VERSION;
    }
    if (rightPart === undefined) {
      return GREATER_VERSION;
    }
    const compared = comparePrereleasePart(leftPart, rightPart);
    if (compared !== EQUAL_VERSION) {
      return compared;
    }
  }

  return EQUAL_VERSION;
};

const compareReleaseVersions = (
  left: ReleaseVersion,
  right: ReleaseVersion
): -1 | 0 | 1 => {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] > right[key]) {
      return GREATER_VERSION;
    }
    if (left[key] < right[key]) {
      return LESSER_VERSION;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
};

/**
 * Whether `latest` is something the running binary should install over
 * `current`. `latest` comes from the authoritative `/version` endpoint, so this
 * is `true` when `latest` has higher SemVer precedence **or** — because every
 * release currently shares the same `0.0.0` core and is distinguished only by a
 * `+<git-sha>` build-metadata tag — when the core precedence is equal but the
 * build metadata differs.
 *
 * SemVer §10 deliberately excludes build metadata from precedence, so
 * `compareReleaseVersions` (used for prerelease ordering) ignores it. This
 * function layers the build-metadata tiebreak on top, scoped to the update
 * decision only, where "the server is serving a different build" means "there
 * is a newer build to install".
 */
const isNewerRelease = (
  current: ReleaseVersion | undefined,
  latest: ReleaseVersion | undefined
): boolean => {
  if (current === undefined || latest === undefined) {
    return false;
  }
  const corePrecedence = compareReleaseVersions(latest, current);
  if (corePrecedence === GREATER_VERSION) {
    return true;
  }
  return corePrecedence === EQUAL_VERSION && latest.build !== current.build;
};

/**
 * Whether the installed release is already exactly the channel's latest build.
 * Both strings must parse, share SemVer core precedence, and carry identical
 * build metadata (`+<git-sha>`). This is the "nothing to install" signal for
 * `ori update`: it is deliberately stricter than `!updateAvailable`, which is
 * also true for a *lower* latest (e.g. installing the alpha channel over a
 * higher stable build, or returning from alpha to a lower stable). Those are
 * intentional channel switches that must still reinstall, so the skip is scoped
 * to an exact match only.
 */
export const isSameRelease = (
  current: string | null,
  latest: string
): boolean => {
  if (current === null) {
    return false;
  }
  const currentParsed = parseReleaseVersion(current);
  const latestParsed = parseReleaseVersion(latest);
  if (currentParsed === undefined || latestParsed === undefined) {
    return false;
  }
  return (
    compareReleaseVersions(currentParsed, latestParsed) === EQUAL_VERSION &&
    currentParsed.build === latestParsed.build
  );
};

export const compareUpdateVersions = (input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string;
}): UpdateCheckResult => {
  const current =
    input.currentVersion === null
      ? undefined
      : parseReleaseVersion(input.currentVersion);
  const latest = parseReleaseVersion(input.latestVersion);
  return {
    currentVersion: input.currentVersion,
    latestVersion: input.latestVersion,
    updateAvailable:
      input.currentVersion === null || isNewerRelease(current, latest),
  };
};

/**
 * Classify how large an available update is relative to the installed release.
 *
 * Returns `none` when nothing newer is available (an equal-or-lower latest with
 * matching build metadata, or an unparseable latest version). An unknown current
 * version (no installed release sidecar) is treated as `major` so it is held for
 * approval rather than applied silently — though in practice the auto-updater
 * cannot mutate an install without a sidecar anyway (see `resolveUpdateInstallDir`).
 *
 * A core-equal release whose `+<git-sha>` build metadata differs is classified
 * as `patch`: today every release shares the `0.0.0` core, so a build-only
 * change is the normal release delta and must be auto-applicable at the `patch`
 * threshold rather than silently dropped as `none`.
 */
export const classifyUpdateSeverity = (
  current: string | null,
  latest: string
): UpdateSeverity => {
  const latestParsed = parseReleaseVersion(latest);
  if (latestParsed === undefined) {
    return "none";
  }
  const currentParsed =
    current === null ? undefined : parseReleaseVersion(current);
  if (currentParsed === undefined) {
    return "major";
  }
  const corePrecedence = compareReleaseVersions(latestParsed, currentParsed);
  if (corePrecedence !== GREATER_VERSION) {
    return corePrecedence === EQUAL_VERSION &&
      latestParsed.build !== currentParsed.build
      ? "patch"
      : "none";
  }
  if (latestParsed.major !== currentParsed.major) {
    return "major";
  }
  if (latestParsed.minor !== currentParsed.minor) {
    return "minor";
  }
  return "patch";
};

export const formatUpdateCheckResult = (result: UpdateCheckResult): string => {
  if (result.currentVersion === null) {
    return [
      `Latest version: ${result.latestVersion}`,
      "Installed version: unknown",
      "Run `ori update` to install the latest version.",
      "",
    ].join("\n");
  }

  if (!result.updateAvailable) {
    return `Ori is up to date (${result.currentVersion}).\n`;
  }

  return [
    `Update available: ${result.currentVersion} -> ${result.latestVersion}`,
    "Run `ori update` to install it.",
    "",
  ].join("\n");
};

export { parseReleaseVersion, ReleaseVersionFromString, UpdateSeveritySchema };
export type { ReleaseVersion, UpdateCheckResult, UpdateSeverity };
