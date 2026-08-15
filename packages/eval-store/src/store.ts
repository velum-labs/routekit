import { createHash } from "node:crypto";
import {
  EVAL_CONTRACT_VERSION,
  EvalEvidence,
  EvalRunResult
} from "@velum-labs/routekit-eval-contracts";
import { RouteKitFailure, writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect, FileSystem, Path, Schema } from "effect";

export class EvalStore {
  constructor(readonly root: string) {}

  writeRawRun(
    result: EvalRunResult
  ): Effect.Effect<string, Error, FileSystem.FileSystem | Path.Path> {
    const root = this.root;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = paths.join(root, "raw");
      const path = paths.join(directory, `${result.runId}.json`);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(directory, 0o700).pipe(Effect.ignore);
      if (yield* fs.exists(path)) {
        return yield* new RouteKitFailure({
          message: `eval run ${result.runId} is immutable and already exists`
        });
      }
      yield* writeFileAtomicEffect(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      return path;
    });
  }

  readRawRun(
    runId: string
  ): Effect.Effect<EvalRunResult | undefined, Error, FileSystem.FileSystem | Path.Path> {
    const root = this.root;
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* readDocument(
        paths.join(root, "raw", `${runId}.json`),
        Schema.decodeUnknownEffect(EvalRunResult),
        `eval run ${runId} is corrupt`
      );
    });
  }

  publish(
    result: EvalRunResult
  ): Effect.Effect<EvalEvidence, Error, FileSystem.FileSystem | Path.Path> {
    const root = this.root;
    return Effect.gen(function* () {
      const evidence: EvalEvidence = {
        version: EVAL_CONTRACT_VERSION,
        runId: result.runId,
        digest: digestFor(result),
        publishedAt: new Date().toISOString()
      };
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const path = paths.join(root, "published.v1.json");
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      yield* fs.chmod(root, 0o700).pipe(Effect.ignore);
      yield* writeFileAtomicEffect(path, `${JSON.stringify(evidence, null, 2)}\n`, {
        mode: 0o600
      });
      return evidence;
    });
  }

  readPublished(): Effect.Effect<
    EvalEvidence | undefined,
    Error,
    FileSystem.FileSystem | Path.Path
  > {
    const root = this.root;
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* readDocument(
        paths.join(root, "published.v1.json"),
        Schema.decodeUnknownEffect(EvalEvidence),
        "published eval snapshot is corrupt"
      );
    });
  }
}

function readDocument<A>(
  path: string,
  decode: (value: unknown) => Effect.Effect<A, unknown>,
  corruptPrefix: string
): Effect.Effect<A | undefined, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return undefined;
    const raw = yield* fs.readFileString(path);
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new RouteKitFailure({
          message: `${corruptPrefix}: ${cause instanceof Error ? cause.message : String(cause)}`
        })
    });
    return yield* decode(json).pipe(
      Effect.mapError(
        (cause) => new RouteKitFailure({ message: `${corruptPrefix}: ${String(cause)}` })
      )
    );
  });
}

function digestFor(result: EvalRunResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

export function makeEvalStore(root: string): EvalStore {
  return new EvalStore(root);
}
