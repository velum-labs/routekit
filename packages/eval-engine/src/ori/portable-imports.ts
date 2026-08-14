/**
 * Adapted from Ori's portable import guard.
 *
 * Ori source:
 * framework/cli/src/commands/eval/portable-imports.ts
 */
import { Effect, FileSystem, Path } from "effect";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node
} from "typescript";

import { EvalImportError } from "../model.js";

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/u;
const PATH_SEGMENT_PATTERN = /[\\/]/u;

const isNonPortable = (specifier: string): boolean =>
  specifier.startsWith("/") ||
  specifier.startsWith("file://") ||
  WINDOWS_DRIVE_PATTERN.test(specifier) ||
  specifier.split(PATH_SEGMENT_PATTERN).includes("node_modules");

export const moduleSpecifiers = (source: string): readonly string[] => {
  const sourceFile = createSourceFile("eval.ts", source, ScriptTarget.Latest, true, ScriptKind.TS);
  const specifiers: string[] = [];
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      isImportEqualsDeclaration(node) &&
      isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      isCallExpression(node) &&
      node.arguments.length === 1 &&
      node.arguments[0] !== undefined &&
      isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

export const nonPortableImportSpecifiers = (source: string): readonly string[] =>
  moduleSpecifiers(source).filter(isNonPortable);

export const ensurePortableEvalImports = Effect.fn("EvalEngine.ensurePortableImports")(function* (
  files: readonly string[]
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = path.resolve();
  const offences = (yield* Effect.forEach(
    files,
    (file) =>
      fs.readFileString(file).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((source) =>
          nonPortableImportSpecifiers(source).map(
            (specifier) => `${path.relative(base, file)} -> ${specifier}`
          )
        )
      ),
    { concurrency: "unbounded" }
  )).flat();

  if (offences.length > 0) {
    return yield* new EvalImportError({ offences });
  }
});
