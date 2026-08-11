export function distillLog(raw: string, options: { maxLines?: number } = {}): string {
  const maxLines = options.maxLines ?? 16;
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  const errorPattern =
    /error|exception|traceback|fatal|denied|unauthorized|forbidden|invalid|not found|refused|timed? ?out|missing|failed|panic|429|401|403|500/i;
  const errorLines = lines.filter((line) => errorPattern.test(line));
  if (errorLines.length > 0) return errorLines.slice(-maxLines).join("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  const head = lines.slice(0, Math.ceil(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [...head, "...", ...tail].join("\n");
}
