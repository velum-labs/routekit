import type { Redacted } from "effect";

import { Effect, Option, Stream } from "effect";
// `effect/unstable/process` is the only Effect-native way to spawn and stream a
// child process; there is no stable equivalent yet, so this depends on it
// deliberately.
import { ChildProcess } from "effect/unstable/process";

import type { ClaudeSessionStartup } from "./process-config.ts";
import type { ClaudeDecodedLine } from "./protocol.ts";
import type { ClaudeCommand } from "./schema.ts";
import type { ClaudeAdapterConfig } from "../config.ts";
import type { JsonlProcess } from "../../../../../engine/acp-adapter-kit/src/jsonl-process.ts";

import { buildClaudeProcess } from "./process-config.ts";
import {
  ClaudeMalformedLine,
  ClaudeProtocolError,
  decodeClaudeLine,
  encodeClaudeCommand,
} from "./protocol.ts";
import {
  isSupportedClaudeVersion,
  parseClaudeVersion,
  SUPPORTED_CLAUDE_VERSION,
} from "./version.ts";
import { ClaudeCredentialError, ClaudeVersionError } from "../errors.ts";
import { RuntimeSecretStore } from "../../../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import { RuntimeSecretName } from "../../../../../contracts/internal/src/runtime/services.ts";
import { makeJsonlProcess } from "../../../../../engine/acp-adapter-kit/src/jsonl-process.ts";

type ClaudeIncoming = ClaudeDecodedLine | ClaudeMalformedLine;

const SPAN_PREFIX = "ClaudeProcess";

// A single spawned Claude Code process. A new ROUTEKIT_EVAL session maps to a fresh
// spawn (--session-id / --resume), so the connection drives one of these per
// session and closes the previous one first.
interface ClaudeProcess extends JsonlProcess<
  ClaudeIncoming,
  ClaudeCommand,
  ClaudeProtocolError
> {
  readonly sessionId: string;
}

// Runs `claude --version` with only PATH so the pinned build is confirmed
// before any credential is read. Callers must invoke this before secrets.
const verifyClaudeVersion = Effect.fn("ClaudeProcess.verifyClaudeVersion")(
  function* (command: string) {
    const handle = yield* ChildProcess.make(command, ["--version"], {
      env: { PATH: process.env.PATH ?? "" },
      extendEnv: false,
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(
      Effect.mapError(
        () =>
          new ClaudeVersionError({
            detail: "Could not spawn Claude to verify its version",
          })
      )
    );
    const output = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runCollect,
      Effect.mapError(
        () =>
          new ClaudeVersionError({
            detail: "Could not read Claude version output",
          })
      )
    );
    const code = yield* handle.exitCode.pipe(
      Effect.mapError(
        () =>
          new ClaudeVersionError({
            detail: "Could not observe Claude version exit",
          })
      )
    );
    if (Number(code) !== 0) {
      return yield* new ClaudeVersionError({
        detail: "Claude version check exited non-zero",
      });
    }
    const version = yield* parseClaudeVersion([...output].join(""));
    if (!isSupportedClaudeVersion(version)) {
      return yield* new ClaudeVersionError({
        detail: `Unsupported Claude version; expected ${SUPPORTED_CLAUDE_VERSION}`,
      });
    }
  },
  Effect.scoped
);

// Resolves the Gateway credential. Kept separate from version verification
// so the gate can be proven to run before this is ever called.
const resolveCredential = Effect.gen(function* () {
  const secrets = yield* RuntimeSecretStore;
  const secret = yield* secrets.get(RuntimeSecretName.GatewayApiKey).pipe(
    Effect.mapError(
      () =>
        new ClaudeCredentialError({
          detail: "Could not read Gateway credential",
        })
    )
  );
  if (Option.isNone(secret)) {
    return yield* new ClaudeCredentialError({
      detail: "Gateway credential is not configured",
    });
  }
  return secret.value;
});

const spawnClaudeProcess = Effect.fn("ClaudeProcess.spawn")(
  function* (launchInput: {
    readonly adapterConfig: ClaudeAdapterConfig;
    readonly credential: Redacted.Redacted;
    readonly startup: ClaudeSessionStartup;
  }) {
    const config = buildClaudeProcess({
      config: launchInput.adapterConfig,
      inheritedCustomHeaders: globalThis.process.env.ANTHROPIC_CUSTOM_HEADERS,
      gatewayApiKey: launchInput.credential,
      startup: launchInput.startup,
    });
    const process = yield* makeJsonlProcess({
      args: config.args,
      command: config.command,
      cwd: config.cwd,
      decodeLine: decodeClaudeLine,
      encodeCommand: encodeClaudeCommand,
      env: config.env,
      onMalformedLine: (error) =>
        new ClaudeMalformedLine({ detail: error.detail }),
      onMalformedUtf8: () =>
        new ClaudeProtocolError({
          detail: "Malformed UTF-8 in Claude JSONL record",
        }),
      onOversizedRecord: () =>
        new ClaudeProtocolError({
          detail: "Claude JSONL record exceeds size limit",
        }),
      spanPrefix: SPAN_PREFIX,
    });
    return {
      ...process,
      sessionId: launchInput.startup.sessionId,
    };
  }
);

export { resolveCredential, spawnClaudeProcess, verifyClaudeVersion };
export type { ClaudeProcess };
