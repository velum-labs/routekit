import {
  assertPublishedRoutingSnapshotV2,
  COMPOSITIONAL_ROUTING_VERSION,
  PublishedRoutingSnapshotV2
} from "@velum-labs/routekit-eval-contracts";
import { RouteKitFailure, writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";

const SNAPSHOT_FILE = "published-routing.v2.json";
const PREVIOUS_SNAPSHOT_FILE = "published-routing.previous.v2.json";
export const ROUTING_SNAPSHOT_V2_MAX_BYTES = 2 * 1024 * 1024;

const publicationTails = new Map<string, Promise<void>>();

export type RoutingSnapshotV2Publication = Omit<
  PublishedRoutingSnapshotV2,
  "version" | "generatedAt"
>;

export class RoutingSnapshotStoreV2 {
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
    PublishedRoutingSnapshotV2 | undefined,
    Error,
    FileSystem.FileSystem | Path.Path
  > {
    const root = this.root;
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* readSnapshotV2(paths.join(root, SNAPSHOT_FILE));
    });
  }

  readPrevious(): Effect.Effect<
    PublishedRoutingSnapshotV2 | undefined,
    Error,
    FileSystem.FileSystem | Path.Path
  > {
    const root = this.root;
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* readSnapshotV2(paths.join(root, PREVIOUS_SNAPSHOT_FILE));
    });
  }

  publish(
    publication: RoutingSnapshotV2Publication
  ): Effect.Effect<PublishedRoutingSnapshotV2, Error, FileSystem.FileSystem | Path.Path> {
    const root = this.root;
    const operation = Effect.gen(function* () {
      const snapshot: PublishedRoutingSnapshotV2 = {
        version: COMPOSITIONAL_ROUTING_VERSION,
        generatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        ...publication
      };
      const decoded = yield* Schema.decodeEffect(PublishedRoutingSnapshotV2)(snapshot).pipe(
        Effect.mapError(
          (cause) =>
            new RouteKitFailure({
              message: `published routing v2 snapshot is invalid: ${String(cause)}`
            })
        )
      );
      yield* Effect.try({
        try: () => assertPublishedRoutingSnapshotV2(decoded),
        catch: (cause) =>
          new RouteKitFailure({
            message: `published routing v2 snapshot is invalid: ${detailOf(cause)}`
          })
      });

      // Check the final representation before rotating the current known-good
      // document. An oversized publication must leave both generations intact.
      const serialized = `${JSON.stringify(decoded, null, 2)}\n`;
      assertBoundedSnapshot(serialized);

      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      yield* fs.chmod(root, 0o700).pipe(Effect.ignore);
      const path = paths.join(root, SNAPSHOT_FILE);
      const previousPath = paths.join(root, PREVIOUS_SNAPSHOT_FILE);
      const current = yield* readSnapshotV2(path);
      if (current !== undefined) {
        const previous = `${JSON.stringify(current, null, 2)}\n`;
        assertBoundedSnapshot(previous);
        yield* writeFileAtomicEffect(previousPath, previous, { mode: 0o600 });
      }
      yield* writeFileAtomicEffect(path, serialized, { mode: 0o600 });
      return decoded;
    });

    return Effect.uninterruptibleMask((restore) =>
      Effect.promise(() => this.#acquirePublication()).pipe(
        Effect.flatMap((release) => restore(operation).pipe(Effect.ensuring(Effect.sync(release))))
      )
    );
  }
}

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertBoundedSnapshot(raw: string): void {
  if (Buffer.byteLength(raw, "utf8") > ROUTING_SNAPSHOT_V2_MAX_BYTES) {
    throw new RouteKitFailure({
      message: `published routing v2 snapshot exceeds the ${String(
        ROUTING_SNAPSHOT_V2_MAX_BYTES
      )} byte limit`
    });
  }
}

function readSnapshotV2(
  path: string
): Effect.Effect<PublishedRoutingSnapshotV2 | undefined, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return undefined;
    const info = yield* fs.stat(path);
    if (Number(info.size) > ROUTING_SNAPSHOT_V2_MAX_BYTES) {
      return yield* new RouteKitFailure({
        message: `published routing v2 snapshot exceeds the ${String(
          ROUTING_SNAPSHOT_V2_MAX_BYTES
        )} byte limit`
      });
    }
    const raw = yield* fs.readFileString(path);
    assertBoundedSnapshot(raw);
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new RouteKitFailure({
          message: `published routing v2 snapshot is corrupt: ${detailOf(cause)}`
        })
    });
    const decoded = yield* Schema.decodeUnknownEffect(PublishedRoutingSnapshotV2)(json).pipe(
      Effect.mapError(
        (cause) =>
          new RouteKitFailure({
            message: `published routing v2 snapshot is corrupt: ${String(cause)}`
          })
      )
    );
    yield* Effect.try({
      try: () => assertPublishedRoutingSnapshotV2(decoded),
      catch: (cause) =>
        new RouteKitFailure({
          message: `published routing v2 snapshot is corrupt: ${detailOf(cause)}`
        })
    });
    return decoded;
  });
}

export function makeRoutingSnapshotStoreV2(root: string): RoutingSnapshotStoreV2 {
  return new RoutingSnapshotStoreV2(root);
}
