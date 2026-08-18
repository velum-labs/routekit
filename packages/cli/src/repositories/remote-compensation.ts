import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

export type RemoteCompensation = {
  remote: string;
  tokenId: string;
  action: "revoke";
  recordedAt: string;
  reason: string;
};

export class RemoteCompensationRepository {
  path(): string {
    return join(routekitHome(), "remote-compensations.v1.json");
  }

  record(compensation: RemoteCompensation): void {
    const path = this.path();
    let entries: RemoteCompensation[] = [];
    if (existsSync(path)) {
      const current = JSON.parse(readFileSync(path, "utf8")) as {
        version?: unknown;
        entries?: unknown;
      };
      if (current.version !== 1 || !Array.isArray(current.entries)) {
        throw new Error(`invalid remote compensation store: ${path}`);
      }
      entries = current.entries.map((entry) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          Array.isArray(entry) ||
          typeof (entry as RemoteCompensation).remote !== "string" ||
          typeof (entry as RemoteCompensation).tokenId !== "string" ||
          (entry as RemoteCompensation).action !== "revoke" ||
          typeof (entry as RemoteCompensation).recordedAt !== "string" ||
          typeof (entry as RemoteCompensation).reason !== "string"
        ) {
          throw new Error(`invalid remote compensation entry: ${path}`);
        }
        return entry as RemoteCompensation;
      });
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(
      path,
      `${JSON.stringify({ version: 1, entries: [...entries, compensation] }, null, 2)}\n`,
      { mode: 0o600 }
    );
    chmodSync(path, 0o600);
  }
}
