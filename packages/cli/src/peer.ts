/**
 * Peer pointer for a non-owner OS account that drives a shared daemon.
 *
 * Stores the absolute path to the owner's secret-free public record plus a
 * durable control-plane token. The control URL is re-read from the public
 * file on every use so it survives daemon restarts (ephemeral control port).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { dirname, join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

export type PeerPointer = {
  version: 1;
  /** Absolute path to the owner's services/daemon.public.json */
  publicRecordPath: string;
  /** Durable control-plane token issued by the owner. */
  controlToken: string;
  addedAt: string;
};

export type DaemonPublicRecord = {
  product: string;
  kind: string;
  url: string;
  port: number;
  generation: number;
  protocolVersion: string;
  dataUrl?: string;
  dataPort?: number;
  startedAt: string;
};

export function peerPointerPath(home: string = routekitHome()): string {
  return join(home, "peer.json");
}

export function readPeerPointer(home: string = routekitHome()): PeerPointer | undefined {
  const path = peerPointerPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PeerPointer>;
    if (
      parsed.version !== 1 ||
      typeof parsed.publicRecordPath !== "string" ||
      typeof parsed.controlToken !== "string" ||
      parsed.controlToken.length === 0 ||
      typeof parsed.addedAt !== "string"
    ) {
      return undefined;
    }
    return {
      version: 1,
      publicRecordPath: parsed.publicRecordPath,
      controlToken: parsed.controlToken,
      addedAt: parsed.addedAt
    };
  } catch {
    return undefined;
  }
}

export function writePeerPointer(
  input: { publicRecordPath: string; controlToken: string },
  home: string = routekitHome()
): PeerPointer {
  if (input.controlToken.length === 0) {
    throw new Error("control token is empty");
  }
  if (!existsSync(input.publicRecordPath)) {
    throw new Error(`public daemon record not found: ${input.publicRecordPath}`);
  }
  // Validate the public record is readable and well-formed before committing.
  readDaemonPublicRecord(input.publicRecordPath);
  const pointer: PeerPointer = {
    version: 1,
    publicRecordPath: input.publicRecordPath,
    controlToken: input.controlToken,
    addedAt: new Date().toISOString()
  };
  const path = peerPointerPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return pointer;
}

export function deletePeerPointer(home: string = routekitHome()): void {
  rmSync(peerPointerPath(home), { force: true });
}

export function readDaemonPublicRecord(path: string): DaemonPublicRecord {
  let parsed: Partial<DaemonPublicRecord>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonPublicRecord>;
  } catch {
    throw new Error(`invalid public daemon record: ${path}`);
  }
  if (
    typeof parsed.product !== "string" ||
    typeof parsed.kind !== "string" ||
    typeof parsed.url !== "string" ||
    typeof parsed.port !== "number" ||
    typeof parsed.generation !== "number" ||
    typeof parsed.protocolVersion !== "string" ||
    typeof parsed.startedAt !== "string"
  ) {
    throw new Error(`incomplete public daemon record: ${path}`);
  }
  return {
    product: parsed.product,
    kind: parsed.kind,
    url: parsed.url,
    port: parsed.port,
    generation: parsed.generation,
    protocolVersion: parsed.protocolVersion,
    startedAt: parsed.startedAt,
    ...(typeof parsed.dataUrl === "string" ? { dataUrl: parsed.dataUrl } : {}),
    ...(typeof parsed.dataPort === "number" ? { dataPort: parsed.dataPort } : {})
  };
}

/** Default path for another user's public record on the same host. */
export function defaultPeerPublicRecordPath(ownerHome: string): string {
  return join(ownerHome, ".routekit", "services", "daemon.public.json");
}
