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
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./index.js";

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
    /** Import an existing plaintext (used for migrating secrets/data-token). */
    plaintext?: string;
  }): IssuedToken;
  list(plane?: TokenPlane): TokenListEntry[];
  revoke(id: string): TokenListEntry;
  resolve(presented: string, plane?: TokenPlane): TokenPrincipal | undefined;
  /** Ensure an owner data token exists; migrate from legacy file if needed. */
  ensureOwnerDataToken(input: {
    plaintext?: string;
    legacyPath?: string;
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
      const syncLegacy = (token: string): void => {
        if (input.legacyPath === undefined) return;
        mkdirSync(dirname(input.legacyPath), { recursive: true, mode: 0o700 });
        writeFileAtomic(input.legacyPath, `${token}\n`, { mode: 0o600 });
        chmodSync(input.legacyPath, 0o600);
      };
      const file = read();
      const existing = file.tokens.find(
        (entry) =>
          entry.plane === "data" &&
          entry.role === "owner" &&
          entry.revokedAt === undefined
      );
      let plaintext = input.plaintext;
      if (plaintext === undefined && input.legacyPath !== undefined && existsSync(input.legacyPath)) {
        plaintext = readFileSync(input.legacyPath, "utf8").trim();
      }
      if (existing !== undefined) {
        if (plaintext === undefined) {
          throw new Error(
            "owner data token exists in the registry but plaintext is unavailable; " +
              "pass --auth-token or restore secrets/data-token"
          );
        }
        if (digestHex(plaintext) !== existing.hash) {
          // Explicit rotation via --auth-token / mismatched legacy file.
          const next = file.tokens.map((entry) =>
            entry.id === existing.id
              ? { ...entry, hash: digestHex(plaintext!), createdAt: new Date().toISOString() }
              : entry
          );
          write({ version: 1, tokens: next });
        }
        syncLegacy(plaintext);
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
      syncLegacy(issued.token);
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
