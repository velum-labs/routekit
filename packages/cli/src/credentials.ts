/**
 * Resolve a credential CLI argument. Pass `-` to read the value from stdin
 * (the form RouteKit uses when crossing SSH, so secrets never appear in argv).
 */
export async function resolveCredentialArgument(value: string): Promise<string> {
  if (value !== "-") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error("join credential is empty");
    }
    return trimmed;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = 64 * 1024;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    size += chunk.byteLength;
    if (size > limit) {
      throw new Error("join credential is too large");
    }
    chunks.push(chunk);
  }
  const trimmed = Buffer.concat(chunks).toString("utf8").trim();
  if (trimmed.length === 0) {
    throw new Error("join credential is empty (expected a value on stdin)");
  }
  return trimmed;
}
