import type { ArtifactReference } from "@velum-labs/routekit-eval-contracts";

const CONTENT_ADDRESSED_INPUT =
  /^(?:datasets|inputs|repositories|indexes|embeddings|retrievals)(?:\/[a-z0-9][a-z0-9._-]*)*\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})(?:\.[a-z0-9_-]+)?$/i;

function contentTypeFor(pathname: string): string {
  if (pathname.endsWith(".json")) return "application/json";
  if (pathname.endsWith(".md")) return "text/markdown";
  if (pathname.endsWith(".txt") || pathname.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

export function isContentAddressedInputPath(pathname: string): boolean {
  const match = CONTENT_ADDRESSED_INPUT.exec(pathname);
  return (
    match?.[1] !== undefined &&
    match[2] !== undefined &&
    match[1].toLowerCase() === match[2].slice(0, 2).toLowerCase()
  );
}

export function artifactReferenceFromPath(pathname: string): ArtifactReference {
  const match = CONTENT_ADDRESSED_INPUT.exec(pathname);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[1].toLowerCase() !== match[2].slice(0, 2).toLowerCase()
  ) {
    throw new Error(
      `input artifact ${JSON.stringify(pathname)} is not a canonical content-addressed path`
    );
  }
  return {
    digest: match[2].toLowerCase(),
    pathname,
    uri: pathname,
    contentType: contentTypeFor(pathname),
    size: 0
  };
}
