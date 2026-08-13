import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { EvalEvidence, EvalRunResult } from "@velum-labs/routekit-eval-contracts";
import { EVAL_CONTRACT_VERSION } from "@velum-labs/routekit-eval-contracts";
import { VersionedDocumentStore, writeFileAtomic } from "@velum-labs/routekit-runtime";
import { createHash } from "node:crypto";

export type EvalStore = {
  readonly root: string;
  writeRawRun(result: EvalRunResult): string;
  readRawRun(runId: string): EvalRunResult | undefined;
  publish(result: EvalRunResult): EvalEvidence;
  readPublished(): EvalEvidence | undefined;
};

function rawPath(root: string, runId: string): string {
  return join(root, "raw", `${runId}.json`);
}

function digestFor(result: EvalRunResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

export function createEvalStore(root: string): EvalStore {
  mkdirSync(join(root, "raw"), { recursive: true, mode: 0o700 });
  const published = new VersionedDocumentStore<EvalEvidence>({
    path: join(root, "published.v1.json"),
    version: EVAL_CONTRACT_VERSION,
    decode: (value) => value as EvalEvidence,
    encode: (value) => value
  });
  return {
    root,
    writeRawRun(result) {
      const path = rawPath(root, result.runId);
      if (existsSync(path)) {
        throw new Error(`eval run ${result.runId} is immutable and already exists`);
      }
      writeFileAtomic(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      return path;
    },
    readRawRun(runId) {
      const store = new VersionedDocumentStore<EvalRunResult>({
        path: rawPath(root, runId),
        version: EVAL_CONTRACT_VERSION,
        decode: (value) => value as EvalRunResult,
        encode: (value) => value
      });
      const result = store.readResult();
      if (result.kind === "valid") return result.value;
      if (result.kind === "corrupt") {
        throw new Error(`eval run ${runId} is corrupt: ${result.diagnostic.message}`);
      }
      return undefined;
    },
    publish(result) {
      const evidence: EvalEvidence = {
        version: EVAL_CONTRACT_VERSION,
        runId: result.runId,
        digest: digestFor(result),
        publishedAt: new Date().toISOString()
      };
      published.write(evidence);
      return evidence;
    },
    readPublished() {
      const result = published.readResult();
      if (result.kind === "corrupt") {
        throw new Error(`published eval snapshot is corrupt: ${result.diagnostic.message}`);
      }
      return result.kind === "valid" ? result.value : undefined;
    }
  };
}
