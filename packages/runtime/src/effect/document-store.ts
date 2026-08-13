import { Effect, FileSystem, Path, PlatformError } from "effect";

import type {
  DocumentReadResult,
  DocumentStoreDiagnostic,
  VersionedDocumentStoreOptions
} from "../versioned-document-store.js";
import { InvalidDocumentVersion } from "./errors.js";
import { writeFileAtomicEffect } from "./files.js";

/**
 * FileSystem-backed validated JSON persistence with an explicit missing/corrupt
 * distinction. Corruption is never silently converted into missing state.
 *
 * The sync `VersionedDocumentStore` in the runtime root remains for account
 * coordinators that still load from constructors; Wave 3 deletes that path.
 */
export class EffectVersionedDocumentStore<T> {
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

  readText(): Effect.Effect<
    string | undefined,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const path = this.#path;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(path))) return undefined;
      return yield* fs.readFileString(path);
    });
  }

  readResult(): Effect.Effect<
    DocumentReadResult<T>,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const path = this.#path;
    const version = this.#version;
    const decode = this.#decode;
    const onDiagnostic = this.#onDiagnostic;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(path))) return { kind: "missing" as const };
      return yield* Effect.matchEffect(
        fs.readFileString(path).pipe(
          Effect.flatMap((text) =>
            Effect.try({
              try: () => {
                const parsed = JSON.parse(text) as unknown;
                if (
                  typeof parsed !== "object" ||
                  parsed === null ||
                  Array.isArray(parsed) ||
                  (parsed as { version?: unknown }).version !== version
                ) {
                  throw new Error(`expected state version ${version}`);
                }
                return { kind: "valid" as const, value: decode(parsed) };
              },
              catch: (cause) => cause
            })
          )
        ),
        {
          onFailure: (cause) => {
            const diagnostic = {
              path,
              message: cause instanceof Error ? cause.message : String(cause),
              cause
            };
            onDiagnostic(diagnostic);
            return Effect.succeed({ kind: "corrupt" as const, diagnostic });
          },
          onSuccess: (value) => Effect.succeed(value)
        }
      );
    });
  }

  read(): Effect.Effect<T | undefined, PlatformError.PlatformError, FileSystem.FileSystem> {
    return Effect.map(this.readResult(), (result) =>
      result.kind === "valid" ? result.value : undefined
    );
  }

  write(
    value: T
  ): Effect.Effect<
    string,
    InvalidDocumentVersion | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const path = this.#path;
    const version = this.#version;
    const encoded = this.#encode(value);
    if (
      typeof encoded !== "object" ||
      encoded === null ||
      Array.isArray(encoded) ||
      (encoded as { version?: unknown }).version !== version
    ) {
      return Effect.fail(
        new InvalidDocumentVersion({
          expected: version,
          message: `state encoder must produce version ${version}`
        })
      );
    }
    const text = `${JSON.stringify(encoded, null, 2)}\n`;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = paths.dirname(path);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(directory, 0o700);
      yield* writeFileAtomicEffect(path, text, { mode: 0o600 });
      return text;
    });
  }
}

export function makeEffectDocumentStore<T>(
  options: VersionedDocumentStoreOptions<T>
): EffectVersionedDocumentStore<T> {
  return new EffectVersionedDocumentStore(options);
}
