import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { BlobNotFoundError, get, head, put } from "@vercel/blob";
import type { ArtifactReference } from "@velum-labs/routekit-eval-contracts";
import { sha256 } from "@velum-labs/routekit-eval-core/experiment";

export type ArtifactPutOptions = {
  kind: string;
  contentType?: string;
  extension?: string;
};

export interface ArtifactStore {
  put(data: Uint8Array | string, options: ArtifactPutOptions): Promise<ArtifactReference>;
  get(reference: ArtifactReference): Promise<Uint8Array>;
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length === 0 ? fallback : normalized;
}

function safeKind(value: string): string {
  const segments = value
    .split("/")
    .filter((segment) => segment.trim().length > 0)
    .map((segment) => safeSegment(segment, "artifacts"));
  return segments.length === 0 ? "artifacts" : segments.join("/");
}

function normalizeExtension(extension: string | undefined, contentType: string): string {
  if (extension !== undefined) return safeSegment(extension.replace(/^\./, ""), "bin");
  if (contentType === "application/json") return "json";
  if (contentType === "text/markdown") return "md";
  if (contentType.startsWith("text/")) return "txt";
  return "bin";
}

function artifactPath(digest: string, options: ArtifactPutOptions, contentType: string): string {
  const kind = safeKind(options.kind);
  const extension = normalizeExtension(options.extension, contentType);
  return `${kind}/sha256/${digest.slice(0, 2)}/${digest}.${extension}`;
}

function bytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(readonly root: string) {}

  async put(data: Uint8Array | string, options: ArtifactPutOptions): Promise<ArtifactReference> {
    const body = bytes(data);
    const digest = sha256(body);
    const contentType = options.contentType ?? "application/octet-stream";
    const pathname = artifactPath(digest, options, contentType);
    const target = this.#target(pathname);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await writeFile(target, body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return {
      digest,
      pathname,
      uri: pathToFileURL(target).href,
      contentType,
      size: body.byteLength
    };
  }

  async get(reference: ArtifactReference): Promise<Uint8Array> {
    const target = this.#target(reference.pathname);
    await access(target);
    const body = await readFile(target);
    if (sha256(body) !== reference.digest) {
      throw new Error(`artifact ${reference.pathname} failed its sha256 check`);
    }
    return body;
  }

  #target(pathname: string): string {
    const root = resolve(this.root);
    const target = resolve(root, pathname);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`artifact path ${JSON.stringify(pathname)} escapes the artifact root`);
    }
    return target;
  }
}

export type VercelBlobArtifactStoreOptions = {
  token?: string;
  storeId?: string;
  oidcToken?: string;
};

export class VercelBlobArtifactStore implements ArtifactStore {
  readonly #auth: VercelBlobArtifactStoreOptions;

  constructor(options: VercelBlobArtifactStoreOptions = {}) {
    this.#auth = options;
  }

  async put(data: Uint8Array | string, options: ArtifactPutOptions): Promise<ArtifactReference> {
    const body = bytes(data);
    const digest = sha256(body);
    const contentType = options.contentType ?? "application/octet-stream";
    const pathname = artifactPath(digest, options, contentType);
    try {
      const existing = await head(pathname, this.#auth);
      return {
        digest,
        pathname: existing.pathname,
        uri: existing.url,
        contentType: existing.contentType,
        size: existing.size
      };
    } catch (error) {
      if (!(error instanceof BlobNotFoundError)) throw error;
    }
    const stored = await put(pathname, Buffer.from(body), {
      ...this.#auth,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType
    });
    return {
      digest,
      pathname: stored.pathname,
      uri: stored.url,
      contentType,
      size: body.byteLength
    };
  }

  async get(reference: ArtifactReference): Promise<Uint8Array> {
    const result = await get(reference.pathname, {
      ...this.#auth,
      access: "private",
      useCache: true
    });
    if (result === null) throw new Error(`artifact ${reference.pathname} does not exist`);
    if (result.statusCode !== 200) throw new Error(`artifact ${reference.pathname} was not read`);
    const body = new Uint8Array(await new Response(result.stream).arrayBuffer());
    if (sha256(body) !== reference.digest) {
      throw new Error(`artifact ${reference.pathname} failed its sha256 check`);
    }
    return body;
  }
}

export async function putJsonArtifact(
  store: ArtifactStore,
  kind: string,
  value: unknown
): Promise<ArtifactReference> {
  return store.put(`${JSON.stringify(value, null, 2)}\n`, {
    kind,
    contentType: "application/json",
    extension: "json"
  });
}

export async function readJsonArtifact<T>(
  store: ArtifactStore,
  reference: ArtifactReference
): Promise<T> {
  const raw = new TextDecoder().decode(await store.get(reference));
  return JSON.parse(raw) as T;
}
