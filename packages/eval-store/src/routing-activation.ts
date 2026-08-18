import {
  assertPublishedRoutingActivation,
  COMPOSITIONAL_ROUTING_VERSION,
  PublishedRoutingActivation
} from "@velum-labs/routekit-eval-contracts";
import { RouteKitFailure, writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";

const SNAPSHOT_FILE = "published-routing.json";
const PREVIOUS_SNAPSHOT_FILE = "published-routing.previous.json";
export const ROUTING_ACTIVATION_MAX_BYTES = 2 * 1024 * 1024;

const publicationTails = new Map<string, Promise<void>>();

export type RoutingActivationPublication = Omit<
  PublishedRoutingActivation,
  "version" | "generatedAt"
>;

export class RoutingActivationConflictError extends Error {
  readonly expectedEvidenceDigest: string | undefined;
  readonly actualEvidenceDigest: string | undefined;

  constructor(
    expectedEvidenceDigest: string | undefined,
    actualEvidenceDigest: string | undefined
  ) {
    super(
      `published routing activation changed: expected ${
        expectedEvidenceDigest === undefined
          ? "no activation"
          : JSON.stringify(expectedEvidenceDigest)
      }, found ${
        actualEvidenceDigest === undefined ? "no activation" : JSON.stringify(actualEvidenceDigest)
      }`
    );
    this.name = "RoutingActivationConflictError";
    this.expectedEvidenceDigest = expectedEvidenceDigest;
    this.actualEvidenceDigest = actualEvidenceDigest;
  }
}

export class RoutingActivationStore {
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
    PublishedRoutingActivation | undefined,
    Error,
    FileSystem.FileSystem | Path.Path
  > {
    const root = this.root;
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* readActivation(paths.join(root, SNAPSHOT_FILE));
    });
  }

  readPrevious(): Effect.Effect<
    PublishedRoutingActivation | undefined,
    Error,
    FileSystem.FileSystem | Path.Path
  > {
    const root = this.root;
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* readActivation(paths.join(root, PREVIOUS_SNAPSHOT_FILE));
    });
  }

  publish(
    publication: RoutingActivationPublication
  ): Effect.Effect<PublishedRoutingActivation, Error, FileSystem.FileSystem | Path.Path> {
    return this.#withPublicationLock(this.#publish(publication));
  }

  /**
   * Publish only if the active evidence generation still matches the caller's
   * view. `undefined` means the caller expects no active publication.
   */
  publishIfCurrent(
    publication: RoutingActivationPublication,
    expectedEvidenceDigest: string | undefined
  ): Effect.Effect<PublishedRoutingActivation, Error, FileSystem.FileSystem | Path.Path> {
    const root = this.root;
    const store = this;
    return this.#withPublicationLock(
      Effect.gen(function* () {
        const paths = yield* Path.Path;
        const current = yield* readActivation(paths.join(root, SNAPSHOT_FILE));
        if (current?.evidenceDigest !== expectedEvidenceDigest) {
          return yield* Effect.fail(
            new RoutingActivationConflictError(expectedEvidenceDigest, current?.evidenceDigest)
          );
        }
        return yield* store.#publish(publication);
      })
    );
  }

  #withPublicationLock<A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.promise(() => this.#acquirePublication()).pipe(
        Effect.flatMap((release) => restore(operation).pipe(Effect.ensuring(Effect.sync(release))))
      )
    );
  }

  #publish(
    publication: RoutingActivationPublication
  ): Effect.Effect<PublishedRoutingActivation, Error, FileSystem.FileSystem | Path.Path> {
    const root = this.root;
    return Effect.gen(function* () {
      const snapshot: PublishedRoutingActivation = {
        version: COMPOSITIONAL_ROUTING_VERSION,
        generatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        ...publication
      };
      const decoded = yield* Schema.decodeEffect(PublishedRoutingActivation)(snapshot).pipe(
        Effect.mapError(
          (cause) =>
            new RouteKitFailure({
              message: `published routing activation is invalid: ${String(cause)}`
            })
        )
      );
      yield* Effect.try({
        try: () => assertPublishedRoutingActivation(decoded),
        catch: (cause) =>
          new RouteKitFailure({
            message: `published routing activation is invalid: ${detailOf(cause)}`
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
      const current = yield* readActivation(path);
      if (current !== undefined) {
        const previous = `${JSON.stringify(current, null, 2)}\n`;
        assertBoundedSnapshot(previous);
        yield* writeFileAtomicEffect(previousPath, previous, { mode: 0o600 });
      }
      yield* writeFileAtomicEffect(path, serialized, { mode: 0o600 });
      return decoded;
    });
  }
}

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertBoundedSnapshot(raw: string): void {
  if (Buffer.byteLength(raw, "utf8") > ROUTING_ACTIVATION_MAX_BYTES) {
    throw new RouteKitFailure({
      message: `published routing activation exceeds the ${String(
        ROUTING_ACTIVATION_MAX_BYTES
      )} byte limit`
    });
  }
}

function readActivation(
  path: string
): Effect.Effect<PublishedRoutingActivation | undefined, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return undefined;
    const info = yield* fs.stat(path);
    if (Number(info.size) > ROUTING_ACTIVATION_MAX_BYTES) {
      return yield* new RouteKitFailure({
        message: `published routing activation exceeds the ${String(
          ROUTING_ACTIVATION_MAX_BYTES
        )} byte limit`
      });
    }
    const raw = yield* fs.readFileString(path);
    assertBoundedSnapshot(raw);
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new RouteKitFailure({
          message: `published routing activation is corrupt: ${detailOf(cause)}`
        })
    });
    const decoded = yield* Schema.decodeUnknownEffect(PublishedRoutingActivation)(json).pipe(
      Effect.mapError(
        (cause) =>
          new RouteKitFailure({
            message: `published routing activation is corrupt: ${String(cause)}`
          })
      )
    );
    yield* Effect.try({
      try: () => assertPublishedRoutingActivation(decoded),
      catch: (cause) =>
        new RouteKitFailure({
          message: `published routing activation is corrupt: ${detailOf(cause)}`
        })
    });
    return decoded;
  });
}

export function makeRoutingActivationStore(root: string): RoutingActivationStore {
  return new RoutingActivationStore(root);
}
