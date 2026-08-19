const OPTIONAL_WATCH_COMMANDS = new Set(["status", "usage"]);

// Effect 4 can make a flag optional, but not the value of a present flag.
export function normalizeOptionalFlagValues(
  argv: readonly string[],
  commandPath: string
): string[] {
  const normalized = [...argv];
  if (!OPTIONAL_WATCH_COMMANDS.has(commandPath)) return normalized;
  const separator = normalized.indexOf("--");
  const end = separator === -1 ? normalized.length : separator;
  for (let index = 0; index < end; index += 1) {
    if (normalized[index] !== "--watch") continue;
    const next = normalized[index + 1];
    if (next !== undefined && !next.startsWith("-")) continue;
    normalized.splice(index + 1, 0, "5");
    index += 1;
  }
  return normalized;
}
