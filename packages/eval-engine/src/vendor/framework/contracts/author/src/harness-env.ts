const EMPTY_COUNT = 0;
const HEADER_SEPARATOR = ": ";
const HEADER_LINE_SEPARATOR = "\n";
const HEADER_NAME_VALUE_SPLIT = /:(.*)/su;

const normalizeEnvValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === EMPTY_COUNT) {
    return undefined;
  }
  return trimmed;
};

const parseHeaderName = (line: string): string | undefined => {
  const [name] = line.split(HEADER_NAME_VALUE_SPLIT);
  const trimmed = name.trim();
  return trimmed.length === EMPTY_COUNT ? undefined : trimmed;
};

/**
 * Merge attribution headers into an existing `ANTHROPIC_CUSTOM_HEADERS` value
 * (newline-separated `Name: Value` pairs) without clobbering headers the caller
 * already set. A header is appended only when its name is absent
 * (case-insensitive), so a user override always wins. Returns `undefined` only
 * when there is nothing to emit.
 */
export const mergeAnthropicCustomHeaders = (
  existing: string | undefined,
  headers: readonly (readonly [string, string])[]
): string | undefined => {
  const existingValue = normalizeEnvValue(existing);
  const existingLines =
    existingValue === undefined ? [] : existingValue.split(/\r?\n/u);
  const presentNames = new Set(
    existingLines
      .map(parseHeaderName)
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase())
  );

  const additions = headers
    .filter(([name]) => !presentNames.has(name.toLowerCase()))
    .map(([name, value]) => `${name}${HEADER_SEPARATOR}${value}`);

  const lines = [...existingLines, ...additions].filter(
    (line) => line.trim().length !== EMPTY_COUNT
  );
  return lines.length === EMPTY_COUNT
    ? undefined
    : lines.join(HEADER_LINE_SEPARATOR);
};

/**
 * A positive-integer millisecond timeout from an env value, or `undefined`
 * when the variable is unset, blank, non-numeric, or non-positive — the shared
 * parse for the harnesses' `ORI_*_TIMEOUT_MS` overrides.
 */
const parseTimeoutMs = (value: string | undefined): number | undefined => {
  const normalized = normalizeEnvValue(value);
  if (normalized === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * The one boolean-env grammar for `ORI_*` flags: `1`/`true`/`yes` (any case,
 * surrounding whitespace ignored) is true, everything else — including unset —
 * is false. Shared here so each harness or feature does not grow its own
 * accepted-spelling set and drift.
 */
const parseBooleanEnv = (value: string | undefined): boolean => {
  const normalized = normalizeEnvValue(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

export { normalizeEnvValue, parseBooleanEnv, parseTimeoutMs };
