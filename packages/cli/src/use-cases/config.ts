import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { acquireLifecycleLock } from "@velum-labs/routekit-runtime";
import { Effect } from "effect";
import { parse as parseYaml } from "yaml";
import { cliTry, cliTryPromise } from "../cli-session.js";
import {
  connectDaemon,
  daemonLifecycleLockPath,
  ensureDaemon,
  readDaemonRecord,
  routekitClient
} from "../client.js";
import { globalRouterConfigPath, writeRouterConfig } from "../config.js";
import { selectedRemoteMetadata } from "../target.js";

export function configImportIdempotencyKey(input: {
  revision: number;
  document: string;
  source: string;
}): string {
  const fingerprint = createHash("sha256")
    .update(String(input.revision))
    .update("\0")
    .update(input.source)
    .update("\0")
    .update(input.document)
    .digest("hex")
    .slice(0, 24);
  return `config-import-${input.revision}-${fingerprint}`;
}

export type ImportRouterConfigResult = {
  imported: true;
  source: string;
  path: string;
  revision: number;
};

export class ImportRouterConfig {
  execute(from: string) {
    return Effect.gen(function* () {
      const source = yield* cliTry(() => {
        const resolved = resolve(from);
        if (!existsSync(resolved)) throw new Error(`router config not found: ${resolved}`);
        return resolved;
      });
      const document = yield* cliTry(() => readFileSync(source, "utf8"));
      const parsed = yield* cliTry(() => parseYaml(document));
      const canonical = globalRouterConfigPath();
      const remote = selectedRemoteMetadata();
      let revision: number | undefined;
      let destination = canonical;

      const replaceThroughDaemon = Effect.gen(function* () {
        const client =
          remote !== undefined
            ? yield* cliTryPromise(() => routekitClient())
            : ((yield* cliTryPromise(() => connectDaemon()))?.client ??
              (yield* cliTryPromise(() => routekitClient())));
        const current = yield* client.call("config.get", {});
        if (remote === undefined && resolve(current.path) !== resolve(canonical)) {
          return yield* Effect.fail(
            new Error(
              `RouteKit is running with foreground config ${current.path}; ` +
                "stop it before importing into the canonical singleton config"
            )
          );
        }
        const imported = yield* client.call(
          "config.import",
          {
            expectedRevision: current.revision,
            document,
            source
          },
          {
            idempotencyKey: configImportIdempotencyKey({
              revision: current.revision,
              document,
              source
            })
          }
        );
        return { revision: imported.revision, path: current.path };
      });

      if (remote === undefined && readDaemonRecord() === undefined) {
        const lock = yield* cliTryPromise(() =>
          acquireLifecycleLock(daemonLifecycleLockPath(), {
            timeoutMs: 90_000
          })
        );
        yield* Effect.gen(function* () {
          if (readDaemonRecord() === undefined) {
            yield* cliTry(() => writeRouterConfig(canonical, parsed));
            const started = yield* cliTryPromise(() =>
              ensureDaemon({
                configPath: canonical,
                lifecycleLockHeld: true
              })
            );
            revision = (yield* started.client.call("config.get", {})).revision;
          }
        }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
      }
      if (revision === undefined) {
        const replaced = yield* replaceThroughDaemon;
        revision = replaced.revision;
        destination = replaced.path;
      }
      return { imported: true as const, source, path: destination, revision };
    });
  }
}
