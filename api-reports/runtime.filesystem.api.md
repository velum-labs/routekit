# @velum-labs/routekit-runtime/filesystem

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `f659188a2c80006a50181d30e6f83c351b6f0dcf6dc49e00e0577ece88825b02`

## Root declarations

```ts
export type { DocumentReadResult, DocumentStoreDiagnostic, VersionedDocumentStoreOptions } from "./filesystem/versioned-document-store.js";
export type { EffectFileLock } from "./filesystem/effect-files.js";
export type { FileLock } from "./filesystem/runtime-files.js";
export { VersionedDocumentStore } from "./filesystem/versioned-document-store.js";
export { captureWorktreeDiff, ensureRunOutputDir, tryAcquireFileLock, writeFileAtomic } from "./filesystem/runtime-files.js";
export { ensureRunOutputDirEffect, tryAcquireFileLockEffect, writeFileAtomicEffect } from "./filesystem/effect-files.js";
```
