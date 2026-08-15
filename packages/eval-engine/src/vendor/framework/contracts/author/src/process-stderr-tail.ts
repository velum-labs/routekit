// NOTE: constants here must not collide with other author modules — the
// contract generator concatenates them into one scaffolded index.
const STDERR_TAIL_EMPTY = 0;
const STDERR_TAIL_MAX_CHARS = 1024;
const STDERR_TAIL_MAX_LINES = 10;

/**
 * The last few non-empty stderr lines, capped by line count and character
 * budget — the bounded diagnostic tail harnesses put in error messages.
 * Undefined when stderr had no content.
 */
export const stderrTail = (stderr: string): string | undefined => {
  const lines = stderr
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > STDERR_TAIL_EMPTY)
    .slice(-STDERR_TAIL_MAX_LINES);
  if (lines.length === STDERR_TAIL_EMPTY) {
    return undefined;
  }
  const tail = lines.join("\n");
  return tail.length <= STDERR_TAIL_MAX_CHARS
    ? tail
    : tail.slice(-STDERR_TAIL_MAX_CHARS);
};
