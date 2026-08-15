import {
  type CompiledRoutingPolicy,
  PublishedRoutingSnapshot,
  ROUTING_SNAPSHOT_VERSION
} from "@velum-labs/routekit-eval-contracts";
import { RouteKitFailure, writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";

const SNAPSHOT_FILE = "published-routing.v1.json";
const PREVIOUS_SNAPSHOT_FILE = "published-routing.previous.v1.json";

export class RoutingSnapshotStore {
  constructor(readonly root: string) {}

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
    return Effect.gen(function* () {
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
          [policy.profileId]: {
            selectedModel: policy.selectedModel,
            fallbackModels: policy.fallbackModels,
            objective: policy.objective,
            suiteDigest: policy.suiteDigest,
            evidenceDigest: policy.evidenceDigest,
            publishedAt
          }
        }
      };
      yield* writeFileAtomicEffect(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
        mode: 0o600
      });
      return snapshot;
    });
  }
}

function readSnapshot(
  path: string
): Effect.Effect<PublishedRoutingSnapshot | undefined, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return undefined;
    const raw = yield* fs.readFileString(path);
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
