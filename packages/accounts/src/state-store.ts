import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "@velum-labs/routekit-runtime";

export type StateStoreDiagnostic = {
  path: string;
  message: string;
  cause?: unknown;
};

export type VersionedStateStoreOptions<T> = {
  path: string;
  version: number;
  decode(value: unknown): T;
  encode(value: T): unknown;
  onDiagnostic?: (diagnostic: StateStoreDiagnostic) => void;
};

/**
 * Validated persistence for account-domain state. Missing files are distinct
 * from corrupt files: callers choose the empty value, while corruption always
 * emits a diagnostic before the state is discarded.
 */
export class VersionedStateStore<T> {
  readonly #path: string;
  readonly #version: number;
  readonly #decode: (value: unknown) => T;
  readonly #encode: (value: T) => unknown;
  readonly #onDiagnostic: (diagnostic: StateStoreDiagnostic) => void;

  constructor(options: VersionedStateStoreOptions<T>) {
    this.#path = options.path;
    if (!Number.isSafeInteger(options.version) || options.version < 1) {
      throw new RangeError("state store version must be a positive safe integer");
    }
    this.#version = options.version;
    this.#decode = options.decode;
    this.#encode = options.encode;
    this.#onDiagnostic =
      options.onDiagnostic ??
      ((diagnostic) => {
        process.stderr.write(
          `routekit rejected corrupt account state ${diagnostic.path}: ${diagnostic.message}\n`
        );
      });
  }

  get path(): string {
    return this.#path;
  }

  readText(): string | undefined {
    return existsSync(this.#path) ? readFileSync(this.#path, "utf8") : undefined;
  }

  read(): T | undefined {
    if (!existsSync(this.#path)) return undefined;
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
      return this.#decode(parsed);
    } catch (cause) {
      this.#onDiagnostic({
        path: this.#path,
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
      return undefined;
    }
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
