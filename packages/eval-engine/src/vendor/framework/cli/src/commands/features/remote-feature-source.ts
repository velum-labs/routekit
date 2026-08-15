import {
  Effect,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
  Struct,
} from "effect";

/**
 * `RemoteFeatureSource` is the decoded shape of a `--features` repo path
 * (`github.com/<owner>/<repo>[/sub/dir][@ref]`). It lives in its own module,
 * shared between `remote-feature-root.ts` (the HTTPS tarball fetch) and
 * `remote-feature-ssh-fallback.ts` (the SSH backup), so neither imports the
 * other for just this type — which would otherwise form an import cycle.
 *
 * The `--features` value is a real boundary: it feeds cache directory names,
 * codeload fetch URLs, and `git`/`tar` subprocess arguments downstream. So the
 * grammar is enforced by decoding the raw string against the schema below
 * rather than by a hand-rolled parser that throws: a malformed value becomes a
 * typed `SchemaError` on the Effect channel.
 */

/** Only host fetched today; the grammar carries the host for future ones. */
export const GITHUB_HOST = "github.com";

/** Ref used when the value has no `@ref`; codeload resolves it to the default branch. */
const DEFAULT_REMOTE_REF = "HEAD";

// `github.com/<owner>/<repo>[/<path>][@<ref>]`, with an optional `https://`
// prefix. Owner/repo are single GitHub-legal segments; the optional path is
// validated segment-by-segment afterwards to rule out traversal.
const REMOTE_SOURCE_PATTERN =
  /^(?:https:\/\/)?github\.com\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+?)(?:\.git)?(?:\/(?<path>[^@]*?))?(?:@(?<ref>[\w./-]+))?\/?$/u;

// A safe relative path segment: no leading dot (rules out `..` and hidden
// escapes), GitHub-legal name characters otherwise.
const PATH_SEGMENT_PATTERN = /^[\w-][\w.-]*$/u;

const RemoteFeatureSourceSchema = Schema.Struct({
  host: Schema.Literal(GITHUB_HOST),
  owner: Schema.String,
  path: Schema.Array(Schema.String),
  ref: Schema.String,
  repo: Schema.String,
}).annotate({ identifier: "RemoteFeatureSource" });

export type RemoteFeatureSource = typeof RemoteFeatureSourceSchema.Type;

// `owner`/`repo` projected off the source schema so the GitHub auth path
// (`github-app-token.ts`) can't drift from the source grammar. Only the type is
// consumed downstream — the schema value exists to derive it — so it stays
// module-private and unexported.
const RepoRefSchema = RemoteFeatureSourceSchema.mapFields(
  Struct.pick(["owner", "repo"])
);

export type RepoRef = typeof RepoRefSchema.Type;

/** Canonical scheme-less form, used in messages and cache bookkeeping. */
export const formatRemoteFeatureSource = (
  source: RemoteFeatureSource
): string => {
  const subPath = source.path.length === 0 ? "" : `/${source.path.join("/")}`;
  const ref = source.ref === DEFAULT_REMOTE_REF ? "" : `@${source.ref}`;
  return `${source.host}/${source.owner}/${source.repo}${subPath}${ref}`;
};

// A `SchemaIssue` carrying the whole raw value on a single line, so the CLI
// renders the same clean one-line failure the hand-rolled parser used to throw
// (no field-path annotation, and the full offending input in the message).
const invalidSource = (
  value: string,
  detail: string
): SchemaIssue.InvalidValue =>
  new SchemaIssue.InvalidValue(Option.some(value), { message: detail });

/**
 * Codec from a raw `--features` value to a {@link RemoteFeatureSource}. All
 * grammar lives in the decode step so a malformed value fails with one
 * `SchemaIssue` that names the whole offending input on a single line: a value
 * that carries no `<owner>/<repo>`, or one whose owner/repo/path segments are
 * not safe cache-directory names (`..`, a leading dot). The struct itself is
 * plain `String` — the fields never see an unvalidated value. The encode step
 * round-trips back to the canonical form so the codec is a real transformation,
 * not a one-way parse.
 */
const RemoteFeatureSourceFromInput = Schema.String.pipe(
  Schema.decodeTo(
    RemoteFeatureSourceSchema,
    SchemaTransformation.transformOrFail({
      decode: (value: string) => {
        const groups = REMOTE_SOURCE_PATTERN.exec(value)?.groups;
        if (groups?.owner === undefined || groups.repo === undefined) {
          return Effect.fail(
            invalidSource(
              value,
              `Invalid remote features source "${value}". Use github.com/<owner>/<repo>[/path][@ref], e.g. github.com/OpenRouterInterns/features.`
            )
          );
        }
        // Owner, repo, and every path segment become cache directory names, so
        // all of them must be safe single segments (no `..`, no leading dot).
        const rawPath = groups.path ?? "";
        const pathSegments = rawPath === "" ? [] : rawPath.split("/");
        const segments = [groups.owner, groups.repo, ...pathSegments];
        for (const segment of segments) {
          if (!PATH_SEGMENT_PATTERN.test(segment)) {
            return Effect.fail(
              invalidSource(
                value,
                `Invalid path segment "${segment}" in remote features source "${value}".`
              )
            );
          }
        }
        return Effect.succeed({
          host: GITHUB_HOST,
          owner: groups.owner,
          path: pathSegments,
          ref: groups.ref ?? DEFAULT_REMOTE_REF,
          repo: groups.repo,
        });
      },
      encode: (source: RemoteFeatureSource) =>
        Effect.succeed(formatRemoteFeatureSource(source)),
    })
  )
);

/** Decode a raw `--features` value known to target GitHub; fails with a `SchemaError`. */
export const decodeRemoteFeatureSource = Schema.decodeUnknownEffect(
  RemoteFeatureSourceFromInput
);

/** Synchronous decode of a value known to target GitHub; throws a `SchemaError`. */
export const decodeRemoteFeatureSourceSync = Schema.decodeUnknownSync(
  RemoteFeatureSourceFromInput
);
