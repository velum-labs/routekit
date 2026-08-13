import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { acquireLifecycleLock } from "@velum-labs/routekit-runtime";
import { parse as parseYaml } from "yaml";
import { runCliEffect } from "../cli-session.js";
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
  async execute(from: string): Promise<ImportRouterConfigResult> {
    const source = resolve(from);
    if (!existsSync(source)) throw new Error(`router config not found: ${source}`);
    const document = readFileSync(source, "utf8");
    const parsed = parseYaml(document);
    const canonical = globalRouterConfigPath();
    const remote = selectedRemoteMetadata();
    let revision: number | undefined;
    let destination = canonical;

    const replaceThroughDaemon = async (): Promise<{ revision: number; path: string }> => {
      const client =
        remote !== undefined
          ? await routekitClient()
          : ((await connectDaemon())?.client ?? (await routekitClient()));
      const current = await runCliEffect(client.call("config.get", {}));
      if (remote === undefined && resolve(current.path) !== resolve(canonical)) {
        throw new Error(
          `RouteKit is running with foreground config ${current.path}; ` +
            "stop it before importing into the canonical singleton config"
        );
      }
      const imported = await runCliEffect(
        client.call(
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
        )
      );
      return { revision: imported.revision, path: current.path };
    };

    if (remote === undefined && readDaemonRecord() === undefined) {
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath(), {
        timeoutMs: 90_000
      });
      try {
        if (readDaemonRecord() === undefined) {
          writeRouterConfig(canonical, parsed);
          const started = await ensureDaemon({
            configPath: canonical,
            lifecycleLockHeld: true
          });
          revision = (await runCliEffect(started.client.call("config.get", {}))).revision;
        }
      } finally {
        lock.release();
      }
    }
    if (revision === undefined) {
      const replaced = await replaceThroughDaemon();
      revision = replaced.revision;
      destination = replaced.path;
    }
    return { imported: true, source, path: destination, revision };
  }
}
