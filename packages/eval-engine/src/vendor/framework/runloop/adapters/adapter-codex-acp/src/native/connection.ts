import type { PlatformError, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import CodexPackage from "@openai/codex/package.json" with { type: "json" };
import { Effect, Queue, Ref } from "effect";

import type { CodexAdapterConfig } from "../config.ts";

import { CodexVersionError } from "../errors.ts";

import type { CodexNativeEvent, ConnectionState } from "./connection-runtime.ts";
import type { CodexConnectionSurface } from "./connection-surface.ts";
import type { CodexProcessTransport } from "./process-transport.ts";

import {
  CodexNativeConnectionError,
  forkExitLoop,
  forkIncomingLoop,
  makeRequest,
  makeShutdown,
} from "./connection-runtime.ts";
import { makeCodexConnectionSurface } from "./connection-surface.ts";
import { makeCodexProcessTransport } from "./process-transport.ts";
import { CODEX_PROTOCOL_VERSION } from "./schema.ts";

const NATIVE_EVENT_CAPACITY = 256;

type CodexNativeConnection = CodexConnectionSurface;

const verifyCodexVersion = (): Effect.Effect<void, CodexVersionError> =>
  CodexPackage.version === CODEX_PROTOCOL_VERSION
    ? Effect.void
    : Effect.fail(
        new CodexVersionError({
          detail: `Installed Codex package is ${CodexPackage.version}; expected ${CODEX_PROTOCOL_VERSION}`,
        })
      );

const makeCodexNativeConnectionFromTransport = Effect.fn(
  "CodexNativeConnection.fromTransport"
)(function* (transport: CodexProcessTransport) {
  const state = yield* Ref.make<ConnectionState>({
    closed: false,
    nextId: 1,
    pending: new Map(),
    shutdown: false,
  });
  const events = yield* Queue.bounded<CodexNativeEvent>(NATIVE_EVENT_CAPACITY);
  const shutdown = makeShutdown(state, events, transport);
  yield* Effect.addFinalizer(() => shutdown);
  yield* forkIncomingLoop(state, events, transport);
  yield* forkExitLoop(state, events, transport);
  const request = makeRequest(state, transport);
  yield* request({
    method: "initialize",
    params: {
      clientInfo: {
        name: "ori",
        title: "Ori",
        version: "0.0.0",
      },
    },
  });
  return makeCodexConnectionSurface({
    events,
    request,
    shutdown,
    transport,
  });
});

const makeCodexNativeConnection = (
  config: CodexAdapterConfig
): Effect.Effect<
  CodexNativeConnection,
  CodexNativeConnectionError | CodexVersionError | PlatformError.PlatformError,
  ChildProcessSpawner | Scope.Scope
> =>
  verifyCodexVersion().pipe(
    Effect.andThen(makeCodexProcessTransport(config)),
    Effect.flatMap(makeCodexNativeConnectionFromTransport)
  );

export {
  CodexNativeConnectionError,
  makeCodexNativeConnection,
  makeCodexNativeConnectionFromTransport,
};
export type { CodexNativeConnection, CodexNativeEvent };
