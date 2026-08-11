/**
 * Hashed token registry for RouteKit data-plane and control-plane credentials.
 *
 * Plaintext is shown once at issue time; only SHA-256 digests are persisted.
 * The owner-role data token is not revocable over the control API.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { writeFileAtomic } from "./runtime-files.js";

/** Versioned peer-enrollment credential: path to the public record + secret. */
const JOIN_CREDENTIAL_PREFIX = "rk1_";

export type JoinCredential = {
  publicRecordPath: string;
  token: string;
};

type JoinCredentialPayload = {
  v: 1;
  p: string;
  t: string;
};

/**
 * Encode a control-plane secret with the absolute path of the owner's
 * `services/daemon.public.json` so a peer can enroll with a single paste.
 */
export function encodeJoinCredential(input: JoinCredential): string {
  if (input.token.length === 0) {
    throw new Error("join credential token is empty");
  }
  if (!isAbsolute(input.publicRecordPath)) {
    throw new Error(
      `join credential public record path must be absolute: ${input.publicRecordPath}`
    );
  }
  const payload: JoinCredentialPayload = {
    v: 1,
    p: input.publicRecordPath,
    t: input.token
  };
  return `${JOIN_CREDENTIAL_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

/**
 * Decode a self-describing peer join credential produced by `encodeJoinCredential`.
 * Rejects bare 0.12.0-style secrets so the caller can ask for a fresh join token.
 */
export function decodeJoinCredential(value: string): JoinCredential {
  if (!value.startsWith(JOIN_CREDENTIAL_PREFIX)) {
    throw new Error(
      "not a RouteKit join credential — ask the owner for a fresh `routekit token issue <label> --plane control` output (rk1_…)"
    );
  }
  const encoded = value.slice(JOIN_CREDENTIAL_PREFIX.length);
  if (encoded.length === 0) {
    throw new Error("join credential is empty after the rk1_ prefix");
  }
  let json: string;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("join credential is not valid base64url");
  }
  if (json.length === 0) {
    throw new Error("join credential is not valid base64url");
  }
  let parsed: Partial<JoinCredentialPayload>;
  try {
    parsed = JSON.parse(json) as Partial<JoinCredentialPayload>;
  } catch {
    throw new Error("join credential payload is not valid JSON");
  }
  if (parsed.v !== 1) {
    throw new Error(
      `unsupported join credential version: ${String(parsed.v)} (expected 1)`
    );
  }
  if (typeof parsed.p !== "string" || parsed.p.length === 0) {
    throw new Error("join credential is missing the public record path");
  }
  if (typeof parsed.t !== "string" || parsed.t.length === 0) {
    throw new Error("join credential is missing the control token");
  }
  if (!isAbsolute(parsed.p)) {
    throw new Error(
      `join credential public record path must be absolute: ${parsed.p}`
    );
  }
  return { publicRecordPath: parsed.p, token: parsed.t };
}

export type TokenPlane = "data" | "control";
export type TokenRole = "owner" | "admin";

export type TokenRecord = {
  id: string;
  label: string;
  plane: TokenPlane;
  role: TokenRole;
  hash: string;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type TokenPrincipal = {
  id: string;
  label: string;
  plane: TokenPlane;
  role: TokenRole;
};

export type IssuedToken = TokenPrincipal & {
  token: string;
};

export type TokenListEntry = Omit<TokenRecord, "hash">;

type TokenStoreFile = {
  version: 1;
  tokens: TokenRecord[];
};

const LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/;

function digestHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBuffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function generateTokenId(): string {
  return randomBytes(8).toString("hex");
}

function generatePlaintext(): string {
  return randomBytes(32).toString("base64url");
}

function validateLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      "token label must be 1-64 chars, start with alphanumeric, and use only [A-Za-z0-9._@-]"
    );
  }
}

function publicEntry(record: TokenRecord): TokenListEntry {
  const { hash: _hash, ...rest } = record;
  return rest;
}

export function tokensPath(home: string): string {
  return join(home, "secrets", "tokens.json");
}

export type TokenStore = {
  path: string;
  issue(input: {
    label: string;
    plane: TokenPlane;
    role?: TokenRole;
    createdBy?: string;
    /** Issue a specific plaintext instead of generating one. */
    plaintext?: string;
  }): IssuedToken;
  list(plane?: TokenPlane): TokenListEntry[];
  revoke(id: string): TokenListEntry;
  resolve(presented: string, plane?: TokenPlane): TokenPrincipal | undefined;
  /** Ensure an owner data token exists and persist its plaintext separately. */
  ensureOwnerDataToken(input: {
    plaintext?: string;
    plaintextPath: string;
  }): { token: string; principal: TokenPrincipal; path: string };
  findByLabel(label: string, plane: TokenPlane): TokenListEntry | undefined;
  get(id: string): TokenListEntry | undefined;
};

export function createTokenStore(home: string): TokenStore {
  const path = tokensPath(home);
  let cache: TokenStoreFile | undefined;

  const read = (): TokenStoreFile => {
    if (cache !== undefined) return cache;
    if (!existsSync(path)) {
      cache = { version: 1, tokens: [] };
      return cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TokenStoreFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) {
        cache = { version: 1, tokens: [] };
        return cache;
      }
      cache = {
        version: 1,
        tokens: parsed.tokens.filter(
          (entry): entry is TokenRecord =>
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.id === "string" &&
            typeof entry.label === "string" &&
            (entry.plane === "data" || entry.plane === "control") &&
            (entry.role === "owner" || entry.role === "admin") &&
            typeof entry.hash === "string" &&
            typeof entry.createdAt === "string"
        )
      };
      return cache;
    } catch {
      cache = { version: 1, tokens: [] };
      return cache;
    }
  };

  const write = (file: TokenStoreFile): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    cache = file;
  };

  const touchLastUsed = (id: string): void => {
    const file = read();
    const index = file.tokens.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const next = [...file.tokens];
    next[index] = { ...next[index]!, lastUsedAt: new Date().toISOString() };
    write({ version: 1, tokens: next });
  };

  return {
    path,
    issue(input) {
      validateLabel(input.label);
      const role = input.role ?? "admin";
      if (role === "owner" && input.plane !== "data") {
        throw new Error("owner role is only valid for data-plane tokens");
      }
      const file = read();
      if (
        role === "owner" &&
        file.tokens.some(
          (entry) =>
            entry.plane === "data" &&
            entry.role === "owner" &&
            entry.revokedAt === undefined
        )
      ) {
        throw new Error("an owner data-plane token already exists");
      }
      const plaintext = input.plaintext ?? generatePlaintext();
      if (plaintext.length === 0) throw new Error("token plaintext is empty");
      const record: TokenRecord = {
        id: generateTokenId(),
        label: input.label,
        plane: input.plane,
        role,
        hash: digestHex(plaintext),
        createdAt: new Date().toISOString(),
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {})
      };
      write({ version: 1, tokens: [...file.tokens, record] });
      return {
        id: record.id,
        label: record.label,
        plane: record.plane,
        role: record.role,
        token: plaintext
      };
    },
    list(plane) {
      return read()
        .tokens.filter((entry) => plane === undefined || entry.plane === plane)
        .map(publicEntry);
    },
    revoke(id) {
      const file = read();
      const index = file.tokens.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`unknown token: ${id}`);
      const current = file.tokens[index]!;
      if (current.role === "owner") {
        throw new Error("owner token cannot be revoked over the control API");
      }
      if (current.revokedAt !== undefined) {
        return publicEntry(current);
      }
      const next = [...file.tokens];
      next[index] = { ...current, revokedAt: new Date().toISOString() };
      write({ version: 1, tokens: next });
      return publicEntry(next[index]!);
    },
    resolve(presented, plane) {
      if (presented.length === 0) return undefined;
      const presentedDigest = digestBuffer(presented);
      const file = read();
      for (const entry of file.tokens) {
        if (entry.revokedAt !== undefined) continue;
        if (plane !== undefined && entry.plane !== plane) continue;
        const stored = Buffer.from(entry.hash, "hex");
        if (stored.length !== presentedDigest.length) continue;
        if (!timingSafeEqual(stored, presentedDigest)) continue;
        // Best-effort last-used stamp; never fail auth on IO.
        try {
          touchLastUsed(entry.id);
        } catch {
          // ignore
        }
        return {
          id: entry.id,
          label: entry.label,
          plane: entry.plane,
          role: entry.role
        };
      }
      return undefined;
    },
    ensureOwnerDataToken(input) {
      const persistPlaintext = (token: string): void => {
        mkdirSync(dirname(input.plaintextPath), { recursive: true, mode: 0o700 });
        writeFileAtomic(input.plaintextPath, `${token}\n`, { mode: 0o600 });
        chmodSync(input.plaintextPath, 0o600);
      };
      const file = read();
      const existing = file.tokens.find(
        (entry) =>
          entry.plane === "data" &&
          entry.role === "owner" &&
          entry.revokedAt === undefined
      );
      let plaintext = input.plaintext;
      if (plaintext === undefined && existsSync(input.plaintextPath)) {
        plaintext = readFileSync(input.plaintextPath, "utf8").trim();
      }
      if (existing !== undefined) {
        if (plaintext === undefined) {
          throw new Error(
            "owner data token exists in the registry but plaintext is unavailable; " +
              "pass --auth-token or restore secrets/data-token"
          );
        }
        if (digestHex(plaintext) !== existing.hash) {
          // Explicit rotation via --auth-token or a changed plaintext file.
          const next = file.tokens.map((entry) =>
            entry.id === existing.id
              ? { ...entry, hash: digestHex(plaintext!), createdAt: new Date().toISOString() }
              : entry
          );
          write({ version: 1, tokens: next });
        }
        persistPlaintext(plaintext);
        return {
          token: plaintext,
          principal: {
            id: existing.id,
            label: existing.label,
            plane: existing.plane,
            role: existing.role
          },
          path
        };
      }
      const issued = this.issue({
        label: "default",
        plane: "data",
        role: "owner",
        ...(plaintext !== undefined ? { plaintext } : {})
      });
      persistPlaintext(issued.token);
      return {
        token: issued.token,
        principal: {
          id: issued.id,
          label: issued.label,
          plane: issued.plane,
          role: issued.role
        },
        path
      };
    },
    findByLabel(label, plane) {
      return read()
        .tokens.filter(
          (entry) =>
            entry.label === label &&
            entry.plane === plane &&
            entry.revokedAt === undefined
        )
        .map(publicEntry)[0];
    },
    get(id) {
      const entry = read().tokens.find((record) => record.id === id);
      return entry === undefined ? undefined : publicEntry(entry);
    }
  };
}
