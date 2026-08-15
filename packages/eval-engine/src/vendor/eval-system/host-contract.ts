/**
 * Host-facing spawn protocol. Additive only: bump `SPAWN_PROTOCOL_VERSION`
 * when a required field or exit-code meaning changes.
 */
const SPAWN_PROTOCOL_VERSION = 2;

const SPAWN_EXIT = {
  ok: 0,
  usage: 2,
  conflict: 3,
  waiting: 75,
} as const;

const SPAWN_COMMANDS = [
  "skill",
  "manifest",
  "prepare",
  "run",
  "answer",
  "status",
  "help",
] as const;

const SPAWN_STATUSES = [
  "prepared",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
  "action-required",
  "auth-required",
  "error",
  "absent",
  "invalid",
] as const;

const AUTHOR_HARNESSES = ["pi", "claude", "codex"] as const;

const MANIFEST_REQUIRED_KEYS = [
  "ok",
  "protocolVersion",
  "harness",
  "authorHarnesses",
  "runModel",
  "judgeModel",
  "skills",
  "host",
] as const;

const HOST_REQUIRED_KEYS = [
  "inferenceOrigin",
  "inferenceOriginEnv",
  "credential",
  "credentialEnv",
] as const;

const PREPARED_REQUIRED_KEYS = ["ok", "status", "runDirectory", "state"] as const;

const WAITING_REQUIRED_KEYS = [
  "ok",
  "status",
  "runDirectory",
  "question",
  "tag",
  "attempt",
  "attemptTotals",
  "evalRunTotals",
] as const;

const ERROR_REQUIRED_KEYS = ["ok", "status", "error"] as const;

export {
  AUTHOR_HARNESSES,
  ERROR_REQUIRED_KEYS,
  HOST_REQUIRED_KEYS,
  MANIFEST_REQUIRED_KEYS,
  PREPARED_REQUIRED_KEYS,
  SPAWN_COMMANDS,
  SPAWN_EXIT,
  SPAWN_PROTOCOL_VERSION,
  SPAWN_STATUSES,
  WAITING_REQUIRED_KEYS,
};
