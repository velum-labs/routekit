export type { CliCaptureOptions, CliCaptureResult } from "./process/cli-capture.js";
export { runCliCapture } from "./process/cli-capture.js";
export type { ExitInfo, Spawned, SuperviseSpawnOptions } from "./process/process.js";
export { superviseSpawn, terminateGroup, terminateProcessGroup } from "./process/process.js";
export { superviseSpawnEffect } from "./process/supervisor.js";
