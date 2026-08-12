import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "./runtime-files.js";

export type DocumentStoreDiagnostic = {
  path: string;
  message: string;
  cause?: unknown;
};

export type DocumentReadResult<T> =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "valid"; value: T }>
  | Readonly<{ kind: "corrupt"; diagnostic: DocumentStoreDiagnostic }>;

export type VersionedDocumentStoreOptions<T> = {
  path: string;
  version: number;
  decode(value: unknown): T;
  encode(value: T): unknown;
  onDiagnostic?: (diagnostic: DocumentStoreDiagnostic) => void;
};

/**
 * Validated, atomic JSON persistence with an explicit missing/corrupt
 * distinction. Corruption is never silently converted into missing state.
 */
export class VersionedDocumentStore<T> {
  readonly #path: string;
  readonly #version: number;
  readonly #decode: (value: unknown) => T;
  readonly #encode: (value: T) => unknown;
  readonly #onDiagnostic: (diagnostic: DocumentStoreDiagnostic) => void;

  constructor(options: VersionedDocumentStoreOptions<T>) {
    this.#path = options.path;
    if (!Number.isSafeInteger(options.version) || options.version < 1) {
      throw new RangeError("document store version must be a positive safe integer");
    }
    this.#version = options.version;
    this.#decode = options.decode;
    this.#encode = options.encode;
    this.#onDiagnostic =
      options.onDiagnostic ??
      ((diagnostic) => {
        process.stderr.write(
          `routekit rejected corrupt document ${diagnostic.path}: ${diagnostic.message}\n`
        );
      });
  }

  get path(): string {
    return this.#path;
  }

  readText(): string | undefined {
    return existsSync(this.#path) ? readFileSync(this.#path, "utf8") : undefined;
  }

  readResult(): DocumentReadResult<T> {
    if (!existsSync(this.#path)) return { kind: "missing" };
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        (parsed as { version?: unknown }).version !== this.#version
      ) {
        throw new Error(`expected state version ${this.#version}`);
      }
      return { kind: "valid", value: this.#decode(parsed) };
    } catch (cause) {
      const diagnostic = {
        path: this.#path,
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      };
      this.#onDiagnostic(diagnostic);
      return { kind: "corrupt", diagnostic };
    }
  }

  read(): T | undefined {
    const result = this.readResult();
    return result.kind === "valid" ? result.value : undefined;
  }

  write(value: T): string {
    const encoded = this.#encode(value);
    if (
      typeof encoded !== "object" ||
      encoded === null ||
      Array.isArray(encoded) ||
      (encoded as { version?: unknown }).version !== this.#version
    ) {
      throw new Error(`state encoder must produce version ${this.#version}`);
    }
    const text = `${JSON.stringify(encoded, null, 2)}\n`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.#path), 0o700);
    writeFileAtomic(this.#path, text, { mode: 0o600 });
    return text;
  }
}
