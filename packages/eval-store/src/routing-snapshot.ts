import {
  assertCompiledRoutingPolicy,
  assertPublishedRoutingCatalog,
  CompiledRoutingPolicy,
  PublishedRoutingSnapshot,
  ROUTING_SNAPSHOT_VERSION
} from "@velum-labs/routekit-eval-contracts";
import { RouteKitFailure, writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";

const SNAPSHOT_FILE = "published-routing.v1.json";
const PREVIOUS_SNAPSHOT_FILE = "published-routing.previous.v1.json";
export const ROUTING_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const publicationTails = new Map<string, Promise<void>>();

export class RoutingSnapshotStore {
  constructor(readonly root: string) {}

  async #acquirePublication(): Promise<() => void> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = publicationTails.get(this.root) ?? Promise.resolve();
    const tail = previous.then(() => current);
    publicationTails.set(this.root, tail);
    await previous;
    return () => {
      release();
      if (publicationTails.get(this.root) === tail) publicationTails.delete(this.root);
    };
  }

  read(): Effect.Effect<
    PublishedRoutingSnapshot | undefined,
    Error,
    FileSystem.FileSystem | Path.Path
  > {
    const root = this.root;
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* readSnapshot(paths.join(root, SNAPSHOT_FILE));
    });
  }

  readPrevious(): Effect.Effect<
    PublishedRoutingSnapshot | undefined,
    Error,
    FileSystem.FileSystem | Path.Path
  > {
    const root = this.root;
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* readSnapshot(paths.join(root, PREVIOUS_SNAPSHOT_FILE));
    });
  }

  publish(
    policy: CompiledRoutingPolicy
  ): Effect.Effect<PublishedRoutingSnapshot, Error, FileSystem.FileSystem | Path.Path> {
    const root = this.root;
    const operation = Effect.gen(function* () {
      const validatedPolicy = yield* Schema.decodeEffect(CompiledRoutingPolicy)(policy).pipe(
        Effect.mapError(
          (cause) =>
            new RouteKitFailure({
              message: `compiled routing policy is invalid: ${String(cause)}`
            })
        )
      );
      yield* Effect.try({
        try: () => assertCompiledRoutingPolicy(validatedPolicy),
        catch: (cause) =>
          new RouteKitFailure({
            message: `compiled routing policy is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
          })
      });
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      yield* fs.chmod(root, 0o700).pipe(Effect.ignore);
      const path = paths.join(root, SNAPSHOT_FILE);
      const previousPath = paths.join(root, PREVIOUS_SNAPSHOT_FILE);
      const current = yield* readSnapshot(path);
      if (current !== undefined) {
        yield* writeFileAtomicEffect(previousPath, `${JSON.stringify(current, null, 2)}\n`, {
          mode: 0o600
        });
      }
      const publishedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const snapshot: PublishedRoutingSnapshot = {
        version: ROUTING_SNAPSHOT_VERSION,
        generatedAt: publishedAt,
        profiles: {
          ...(current?.profiles ?? {}),
          [validatedPolicy.profileId]: {
            selectedModel: validatedPolicy.selectedModel,
            fallbackModels: validatedPolicy.fallbackModels,
            objective: validatedPolicy.objective,
            suiteDigest: validatedPolicy.suiteDigest,
            evidenceDigest: validatedPolicy.evidenceDigest,
            publishedAt,
            ...(validatedPolicy.description !== undefined
              ? { description: validatedPolicy.description }
              : {}),
            ...(validatedPolicy.evidence.length > 0
              ? {
                  evidence: validatedPolicy.evidence.map((entry) => ({
                    model: entry.model,
                    ...(entry.passRate !== undefined ? { passRate: entry.passRate } : {}),
                    ...(entry.averageJudgeScore !== undefined
                      ? { averageJudgeScore: entry.averageJudgeScore }
                      : {}),
                    ...(entry.averageCostUsd !== undefined
                      ? { averageCostUsd: entry.averageCostUsd }
                      : {})
                  }))
                }
              : {})
          }
        }
      };
      yield* Effect.try({
        try: () => assertPublishedRoutingCatalog(snapshot.profiles),
        catch: (cause) =>
          new RouteKitFailure({
            message: `published routing catalog is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
          })
      });
      yield* writeFileAtomicEffect(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
        mode: 0o600
      });
      return snapshot;
    });
    return Effect.uninterruptibleMask((restore) =>
      Effect.promise(() => this.#acquirePublication()).pipe(
        Effect.flatMap((release) => restore(operation).pipe(Effect.ensuring(Effect.sync(release))))
      )
    );
  }
}

function readSnapshot(
  path: string
): Effect.Effect<PublishedRoutingSnapshot | undefined, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return undefined;
    const info = yield* fs.stat(path);
    if (Number(info.size) > ROUTING_SNAPSHOT_MAX_BYTES) {
      return yield* new RouteKitFailure({
        message: `published routing snapshot exceeds the ${String(ROUTING_SNAPSHOT_MAX_BYTES)} byte limit`
      });
    }
    const raw = yield* fs.readFileString(path);
    if (Buffer.byteLength(raw, "utf8") > ROUTING_SNAPSHOT_MAX_BYTES) {
      return yield* new RouteKitFailure({
        message: `published routing snapshot exceeds the ${String(ROUTING_SNAPSHOT_MAX_BYTES)} byte limit`
      });
    }
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new RouteKitFailure({
          message: `published routing snapshot is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`
        })
    });
    return yield* Schema.decodeUnknownEffect(PublishedRoutingSnapshot)(json).pipe(
      Effect.mapError(
        (cause) =>
          new RouteKitFailure({
            message: `published routing snapshot is corrupt: ${String(cause)}`
          })
      )
    );
  });
}

export function makeRoutingSnapshotStore(root: string): RoutingSnapshotStore {
  return new RoutingSnapshotStore(root);
}
