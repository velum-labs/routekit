import { Effect, Schema } from "effect";

import { ClaudeVersionParseError } from "../errors.ts";

// One semver source of truth: reused by both the banner regex and the brand's
// pattern check, so a value the regex captures always satisfies the brand and
// `ClaudeVersion.make` is total over captures (never a native throw/defect).
const SEMVER_SOURCE = String.raw`\d+\.\d+\.\d+`;

const ClaudeVersion = Schema.String.check(
  Schema.isPattern(new RegExp(`^${SEMVER_SOURCE}$`, "u"))
).pipe(Schema.brand("ClaudeVersion"));
type ClaudeVersion = typeof ClaudeVersion.Type;

// `claude --version` prints e.g. "2.1.197 (Claude Code)" (also tolerates a bare
// semver or a "Claude Code <semver>" prefix). No JSON mode exists: --output-format
// applies only to --print, so a regex over the human string is the only option.
const CLAUDE_VERSION_BANNER = new RegExp(
  `^(?:Claude Code\\s+)?(${SEMVER_SOURCE})(?:\\s+\\(Claude Code\\))?$`,
  "u"
);

const SUPPORTED_CLAUDE_VERSION = ClaudeVersion.make("2.1.197");

const parseClaudeVersion = (
  stdout: string
): Effect.Effect<ClaudeVersion, ClaudeVersionParseError> => {
  const match = CLAUDE_VERSION_BANNER.exec(stdout.trim());
  if (match === null) {
    return Effect.fail(
      new ClaudeVersionParseError({
        detail: `Claude version output is malformed: ${JSON.stringify(stdout)}`,
        rawStdout: stdout,
      })
    );
  }
  return Effect.succeed(ClaudeVersion.make(match[1]));
};

const isSupportedClaudeVersion = (version: ClaudeVersion): boolean =>
  version === SUPPORTED_CLAUDE_VERSION;

export {
  isSupportedClaudeVersion,
  parseClaudeVersion,
  SUPPORTED_CLAUDE_VERSION,
};
