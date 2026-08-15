// The guard runs at discovery, before any file reaches `node --test`: an eval
// that imports by absolute path passes on the machine that wrote it and fails
// everywhere else, so it has to fail on the author's machine rather than on a
// teammate's. Specifiers come from the TypeScript scanner rather than a text
// scan — an eval about file paths may legitimately hold an absolute path in a
// string literal or a comment, and neither of those is an import.
import { Effect, FileSystem, Path, Result } from "effect";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/u;
const PATH_SEGMENT_PATTERN = /[\\/]/u;
// The scanner is happier without a shebang, and `node --test` still runs such a
// file — stripping the line keeps a valid eval from silently skipping the scan.
const SHEBANG_PATTERN = /^#!.*/u;

const isNonPortable = (specifier: string): boolean =>
  specifier.startsWith("/") ||
  specifier.startsWith("file://") ||
  WINDOWS_DRIVE_PATTERN.test(specifier) ||
  specifier.split(PATH_SEGMENT_PATTERN).includes("node_modules");

const isModuleString = (
  prev: SyntaxKind,
  prev2: SyntaxKind,
  prev2Text: string
): boolean =>
  prev === SyntaxKind.FromKeyword ||
  prev === SyntaxKind.ImportKeyword ||
  (prev === SyntaxKind.OpenParenToken && prev2 === SyntaxKind.ImportKeyword) ||
  (prev === SyntaxKind.OpenParenToken && prev2Text === "require");

const collectModuleSpecifiers = (source: string): readonly string[] => {
  const scanner = createScanner(true, undefined, source);
  const specifiers: string[] = [];
  let prev: SyntaxKind = SyntaxKind.Unknown;
  let prev2: SyntaxKind = SyntaxKind.Unknown;
  let prev2Text = "";
  let prevText = "";
  let token = scanner.scan();
  while (token !== SyntaxKind.EndOfFile) {
    if (token === SyntaxKind.StringLiteral && isModuleString(prev, prev2, prev2Text)) {
      specifiers.push(scanner.getTokenValue());
    }
    prev2 = prev;
    prev2Text = prevText;
    prev = token;
    prevText = scanner.isIdentifier() ? scanner.getTokenValue() : "";
    token = scanner.scan();
  }
  return specifiers;
};

/**
 * Every import/export specifier in `source` that only resolves on one machine.
 *
 * A file the scanner cannot tokenize yields nothing: a syntax error is `node
 * --test`'s to report, with its column and caret, and this guard has no standing
 * to pre-empt that with a worse message.
 */
export const nonPortableImportSpecifiers = (
  source: string
): readonly string[] => {
  const scannable = source.replace(SHEBANG_PATTERN, "");
  return Result.getOrElse(
    Result.try(() => collectModuleSpecifiers(scannable).filter(isNonPortable)),
    (): readonly string[] => []
  );
};

export const ensurePortableEvalImports = Effect.fn(
  "EvalCommand.ensurePortableImports"
)(function* (files: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Named relative to where the caller is standing, not to the run's working
  // directory: the latter is the named file's own parent when a single eval is
  // named, which labelled the offence with a bare basename in that one mode and
  // a repo-relative path in every other.
  const base = path.resolve();

  const offences = (yield* Effect.forEach(
    files,
    (file) =>
      fs.readFileString(file).pipe(
        // A file that cannot be read is not this guard's business: `node --test`
        // reports it with the error the author needs.
        Effect.orElseSucceed(() => ""),
        Effect.map((source) =>
          nonPortableImportSpecifiers(source).map(
            (specifier) => `  ${path.relative(base, file)} -> ${specifier}`
          )
        )
      ),
    { concurrency: "unbounded" }
  )).flat();

  if (offences.length === 0) {
    return;
  }

  return yield* new CliFailureError({
    detail: `Eval files must import by package name or repo-relative path so they run on any machine. Absolute imports found:\n${offences.join("\n")}`,
    hint: 'Import the SDK as `routekit/eval`, and the code under test by a path relative to the eval file (for example "../../src/classify"). Nothing was run.',
  });
});
