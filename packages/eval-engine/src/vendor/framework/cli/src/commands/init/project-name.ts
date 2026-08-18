import { Effect } from "effect";
import { Prompt } from "effect/unstable/cli";

import { ProjectInitError } from "./author-contracts.ts";

interface ResolveProjectNameInput {
  /** Whether stdin is interactive; the caller owns `CliIo` and passes this in. */
  readonly isTty: boolean;
  /** Explicit name from the positional argument, if any. */
  readonly name?: string | undefined;
}

const NAME_REQUIRED_EXIT_CODE = 1;
const RANDOM_SLOT_COUNT = 1;

// Hand-rolled word lists to avoid pulling in a dependency for a readable
// adjective-noun default.
const ADJECTIVES = [
  "amber",
  "azure",
  "brave",
  "calm",
  "clever",
  "eager",
  "gentle",
  "jolly",
  "lucky",
  "mellow",
  "nimble",
  "quiet",
  "swift",
  "witty",
] as const;

const NOUNS = [
  "badger",
  "cedar",
  "comet",
  "falcon",
  "harbor",
  "heron",
  "lantern",
  "maple",
  "meadow",
  "otter",
  "pixel",
  "river",
  "sparrow",
  "willow",
] as const;

/**
 * Coerce arbitrary input into a kebab-case workspace name: lowercase, collapse
 * whitespace/underscores to single dashes, drop characters outside `[a-z0-9-]`,
 * and trim stray dashes. May return an empty string when nothing usable remains;
 * callers validate that separately.
 */
const normalizeProjectName = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/gu, "-")
    .replaceAll(/[^a-z0-9-]/gu, "")
    .replaceAll(/-{2,}/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

const cryptoRandomIndex = (bound: number): number => {
  const buffer = new Uint32Array(RANDOM_SLOT_COUNT);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0] % bound;
};

/**
 * Generate a readable adjective-noun default name. `pickIndex` is injectable so
 * tests can make the choice deterministic.
 */
export const generateReadableName = (
  pickIndex: (bound: number) => number = cryptoRandomIndex
): string =>
  `${ADJECTIVES[pickIndex(ADJECTIVES.length)]}-${NOUNS[pickIndex(NOUNS.length)]}`;

/**
 * Resolve the workspace name argument for `ori init`:
 * - An explicit positional is returned verbatim so it can be a path target
 *   (e.g. `../playground`); the caller derives the package name from its basename.
 * - No positional + a TTY prompts via Effect's native `Prompt.text`, defaulting
 *   to a generated readable name (Enter accepts the default).
 * - No positional + no TTY is an error, so non-interactive callers fail loudly
 *   instead of scaffolding into an unexpected directory.
 */
export const resolveProjectName = Effect.fn("ProjectInit.resolveName")(
  function* (input: ResolveProjectNameInput) {
    if (input.name !== undefined) {
      return input.name;
    }

    if (!input.isTty) {
      return yield* new ProjectInitError({
        detail: "Missing project name. Try `ori init my-intern`.",
        exitCode: NAME_REQUIRED_EXIT_CODE,
        operation: "resolving the project name",
      });
    }

    const suggestion = generateReadableName();
    const answer = yield* Prompt.text({
      message: `Name your intern (default: ${suggestion})`,
    });
    const normalized = normalizeProjectName(answer);
    return normalized === "" ? suggestion : normalized;
  }
);

export { normalizeProjectName };
export type { ResolveProjectNameInput };
