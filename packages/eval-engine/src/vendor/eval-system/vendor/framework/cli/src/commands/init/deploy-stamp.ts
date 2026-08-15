import type { Crypto } from "effect";

import { Effect, Encoding } from "effect";

const STAMP_PATTERN = /^# routekit-eval-managed: (\S+) (\S+)$/u;
// Docker parser directives (`# syntax=`, `# escape=`, `# check=`) are only
// honored while they are the leading lines of a Dockerfile, so the managed
// stamp must sit below them, never above.
const PARSER_DIRECTIVE_PATTERN = /^#\s*(?:syntax|escape|check)\s*=/u;
const SHA_256: Crypto.DigestAlgorithm = "SHA-256";
const textEncoder = new TextEncoder();

export const normalizeDeployContent = (content: string): string => {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
};

const directiveLineCount = (lines: readonly string[]): number => {
  let count = 0;
  while (PARSER_DIRECTIVE_PATTERN.test(lines[count] ?? "")) {
    count += 1;
  }
  return count;
};

export const parseDeployStamp = (
  content: string
): { readonly version: string; readonly hash: string } | undefined => {
  const lines = normalizeDeployContent(content).split("\n");
  const stampLine = lines[directiveLineCount(lines)] ?? "";
  const [_, version, hash] = STAMP_PATTERN.exec(stampLine) ?? [];
  return version === undefined || hash === undefined
    ? undefined
    : {
        hash,
        version,
      };
};

export const stripDeployStamp = (content: string): string => {
  const lines = normalizeDeployContent(content).split("\n");
  const index = directiveLineCount(lines);
  return STAMP_PATTERN.test(lines[index] ?? "")
    ? [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n")
    : lines.join("\n");
};

export const stampDeployContent = (
  version: string,
  hash: string,
  content: string
): string => {
  const lines = normalizeDeployContent(content).split("\n");
  const index = directiveLineCount(lines);
  return [
    ...lines.slice(0, index),
    `# routekit-eval-managed: ${version} ${hash}`,
    ...lines.slice(index),
  ].join("\n");
};

export const hashDeployContent = Effect.fn("DeployStamp.hash")(function* (
  crypto: Crypto.Crypto,
  content: string
) {
  const digest = yield* crypto.digest(
    SHA_256,
    textEncoder.encode(normalizeDeployContent(content))
  );
  return Encoding.encodeHex(digest);
});
