export function numberOption(
  value: string,
  label: string,
  input: { min: number; max: number }
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < input.min || parsed > input.max) {
    throw new Error(`${label} must be between ${input.min} and ${input.max}`);
  }
  return parsed;
}
