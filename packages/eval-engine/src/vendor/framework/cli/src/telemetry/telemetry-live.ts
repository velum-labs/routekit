import {
  Clock,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { TelemetryShape } from "./telemetry.ts";
import type {
  TelemetryEvent,
  TelemetryEventName,
  TelemetryProps,
} from "./telemetry-event.ts";
import type { TelemetryState } from "./telemetry-state.ts";

import { CliIo } from "../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../contracts/internal/src/cli/host-process.ts";
import { isCompiledCliBuild } from "../build-info.ts";
import { readVersionInfo } from "../commands/version/version-info.ts";
import { Telemetry } from "./telemetry.ts";
import { detectTelemetryEnvKind } from "./telemetry-env-kind.ts";
import {
  makeTelemetryEvent,
  MAX_EVENTS_PER_BATCH,
  TelemetryBatchSchema,
  TelemetryIdentitySchema,
  TelemetryPropsFromInput,
} from "./telemetry-event.ts";
import {
  readOrCreateTelemetryState,
  writeTelemetryState,
} from "./telemetry-state.ts";

import type {
  TelemetryLayerOptions,
  TelemetryLiveLayer,
} from "./telemetry-live-types.ts";

import {
  enrichAgentRunProps,
  handleSessionEnd,
  appendTelemetryEvent,
  makeFlush,
  persistFirstAgentRun,
  recordAgentRun,
  startTelemetryLifecycle,
} from "./telemetry-live-effects.ts";

export type { TelemetryLiveLayer } from "./telemetry-live-types.ts";

/**
 * RFC 0012 usage telemetry client. Anonymous product-usage events are
 * buffered in memory and flushed in the background to the OpenRouter ingest
 * endpoint: at 20 buffered events, every 30 seconds, and on scope close with
 * a hard 500 ms timeout. Every response is fire-and-forget — a failed or
 * rejected batch is dropped without retry, stderr output, or non-debug logs.
 * Telemetry must never degrade the user experience.
 */

const TELEMETRY_ENDPOINT = "https://openrouter.ai/api/v1/ori/telemetry";
const TELEMETRY_ENV = "ORI_TELEMETRY";
/**
 * Buffered-event count that triggers an eager background flush (RFC 0012).
 * Exported so the adapter test asserts the auto-flush branch against the real
 * threshold rather than a drifting literal.
 */
export const FLUSH_THRESHOLD = 20;
const FLUSH_INTERVAL = "30 seconds";
const EXIT_FLUSH_TIMEOUT = "500 millis";

export const activationElapsedMs = (
  installedAtMs: number | undefined,
  nowMs: number
): number | undefined => {
  if (
    installedAtMs === undefined ||
    !Number.isSafeInteger(installedAtMs) ||
    !Number.isSafeInteger(nowMs) ||
    installedAtMs > nowMs
  ) {
    return undefined;
  }
  return nowMs - installedAtMs;
};

const firstAgentRunActivationProps = (
  installedAtMs: number | undefined,
  nowMs: number
): TelemetryProps => {
  const elapsed = activationElapsedMs(installedAtMs, nowMs);
  return elapsed === undefined
    ? {}
    : {
        is_first_agent_run: true,
        time_to_first_agent_run_ms: elapsed,
      };
};

/**
 * One-time stderr disclosure printed on the first run that would emit
 * telemetry (RFC 0012 "Opt-out and disclosure").
 */
export const boxNotice = (body: string): string => {
  const lines = body.split("\n");
  const width = Math.max(...lines.map((line) => line.length));
  const border = "─".repeat(width + 2);

  return [
    `╭${border}╮`,
    ...lines.map((line) => `│ ${line.padEnd(width)} │`),
    `╰${border}╯`,
  ].join("\n");
};

const FIRST_RUN_NOTICE_BODY = ` ██████╗ ██████╗ ██╗
██╔═══██╗██╔══██╗██║
██║   ██║██████╔╝██║
██║   ██║██╔══██╗██║
╚██████╔╝██║  ██║██║
 ╚═════╝ ╚═╝  ╚═╝╚═╝
Your favorite harness with every model.

Ori collects anonymous usage telemetry to improve the CLI.
It records which CLI commands you run (like \`ori code\` or \`ori tui\`),
how long they take, and whether they succeed.
It never records your prompts or credentials. Failed commands may include
sanitized error text and stack frames; user paths are removed.
Disable it any time with ${TELEMETRY_ENV}=0.`;

const FIRST_RUN_NOTICE = `${boxNotice(FIRST_RUN_NOTICE_BODY)}\n`;

const noopShape: TelemetryShape = {
  emit: () => Effect.void,
  flush: Effect.void,
};

const isDisabledEnvValue = (value: string | undefined): boolean =>
  value === "0" || value === "false";

const postBatch = Effect.fn("Telemetry.postBatch")(
  function* (
    client: HttpClient.HttpClient,
    events: readonly TelemetryEvent[],
    apiKey: string | undefined
  ) {
    // Encode failure here means an out-of-bounds event slipped past the upstream
    // clamps — a real bug the fail-closed drop would otherwise hide. Surface it
    // at debug level only (never stderr, per the never-degrade-UX contract).
    const request = yield* HttpClientRequest.post(TELEMETRY_ENDPOINT).pipe(
      HttpClientRequest.schemaBodyJson(TelemetryBatchSchema)({ events }),
      Effect.tapError((error) =>
        Effect.logDebug("telemetry batch failed to encode", error)
      )
    );
    yield* client.execute(
      apiKey === undefined
        ? request
        : HttpClientRequest.bearerToken(request, apiKey)
    );
  },
  (effect) => Effect.ignore(effect)
);

const makeIdentity = Effect.fn("Telemetry.makeIdentity")(function* (
  installId: string,
  env: Record<string, string | undefined>
) {
  const cryptoService = yield* Crypto.Crypto;
  const sessionId = yield* cryptoService.randomUUIDv4;
  const cliVersion = yield* readVersionInfo.pipe(
    Effect.map((info) => info.version),
    Effect.orElseSucceed(() => "0.0.0")
  );
  return yield* Schema.decodeUnknownEffect(TelemetryIdentitySchema)({
    arch: process.arch,
    cliVersion,
    installId,
    os: process.platform,
    sessionId,
    envKind: detectTelemetryEnvKind({
      cliVersion,
      env,
      isReleasedBuild: isCompiledCliBuild(),
    }),
  });
});

/** First-use side effects: the one-time notice and the `install_first_run` event. */
const runFirstUse = Effect.fn("Telemetry.runFirstUse")(function* (
  stateRef: Ref.Ref<TelemetryState>,
  emit: TelemetryShape["emit"],
  persist: Effect.Effect<void>
) {
  const state = yield* Ref.get(stateRef);
  if (state.noticeShown && state.firstRunSent) {
    return;
  }
  const cliIo = yield* CliIo;
  if (!state.noticeShown) {
    yield* cliIo.writeStderr(FIRST_RUN_NOTICE).pipe(Effect.ignore);
  }
  if (!state.firstRunSent) {
    yield* emit("install_first_run", { install_method: "unknown" });
  }
  yield* Ref.update(stateRef, (current) => ({
    ...current,
    firstRunSent: true,
    noticeShown: true,
  }));
  yield* persist;
});

const persistTelemetryState = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly hostProcess: HostProcess["Service"];
  readonly path: Path.Path;
  readonly stateRef: Ref.Ref<TelemetryState>;
}): Effect.Effect<void> =>
  Ref.get(input.stateRef).pipe(
    Effect.flatMap((state) => writeTelemetryState(state)),
    Effect.provideService(HostProcess, input.hostProcess),
    Effect.provideService(FileSystem.FileSystem, input.fs),
    Effect.provideService(Path.Path, input.path),
    Effect.ignore
  );

const makeEmit = (input: {
  readonly buffer: Ref.Ref<readonly TelemetryEvent[]>;
  readonly counters: Ref.Ref<{
    readonly cancelledRuns: number;
    readonly runs: number;
  }>;
  readonly sessionStarted: Ref.Ref<boolean>;
  readonly sessionStartedAt: Ref.Ref<number>;
  readonly flush: Effect.Effect<void>;
  readonly fs: FileSystem.FileSystem;
  readonly hostProcess: HostProcess["Service"];
  readonly identity: typeof TelemetryIdentitySchema.Type;
  readonly path: Path.Path;
  readonly stateRef: Ref.Ref<TelemetryState>;
}): TelemetryShape["emit"] =>
  Effect.fn("Telemetry.emit")(function* (
    event: TelemetryEventName,
    props?: TelemetryProps
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cleanProps = yield* Schema.decodeUnknownEffect(
      TelemetryPropsFromInput
    )(props ?? {}).pipe(Effect.orElseSucceed((): TelemetryProps => ({})));
    const enrichedProps = yield* enrichAgentRunProps({
      event,
      nowMs,
      props: cleanProps,
      stateRef: input.stateRef,
      firstAgentRunActivationProps,
    });
    if (event === "agent_run" && enrichedProps.surface !== "surface-direct") {
      yield* recordAgentRun({
        buffer: input.buffer,
        counters: input.counters,
        identity: input.identity,
        nowMs,
        props: enrichedProps,
        sessionStarted: input.sessionStarted,
        sessionStartedAt: input.sessionStartedAt,
      });
    }
    if (event === "session_end") {
      return yield* handleSessionEnd({
        ...input,
        nowMs,
        props: enrichedProps,
      });
    }
    if (event === "agent_run" && enrichedProps.is_first_agent_run === true) {
      yield* persistFirstAgentRun(persistTelemetryState(input));
    }
    const entry = makeTelemetryEvent({
      event,
      identity: input.identity,
      now: new Date(nowMs),
      props: enrichedProps,
    });
    yield* appendTelemetryEvent({
      buffer: input.buffer,
      entry,
      flush: input.flush,
      flushThreshold: FLUSH_THRESHOLD,
    });
  });

const makeLiveShape = Effect.fn("Telemetry.makeLive")(function* (options: {
  readonly emitFirstUse: boolean;
}) {
  const hostProcess = yield* HostProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const state = yield* readOrCreateTelemetryState();
  const stateRef = yield* Ref.make(state);
  const env = yield* hostProcess.env;
  const identity = yield* makeIdentity(state.installId, env);
  const buffer = yield* Ref.make<readonly TelemetryEvent[]>([]);
  const counters = yield* Ref.make({
    cancelledRuns: 0,
    runs: 0,
  });
  const sessionStarted = yield* Ref.make(false);
  const sessionStartedAt = yield* Ref.make(0);
  const flush = makeFlush({
    buffer,
    client,
    hostProcess,
    maxEventsPerBatch: MAX_EVENTS_PER_BATCH,
    postBatch,
  });
  const emit = makeEmit({
    buffer,
    counters,
    flush,
    fs,
    hostProcess,
    identity,
    path,
    stateRef,
    sessionStarted,
    sessionStartedAt,
  });
  const persist = persistTelemetryState({
    fs,
    hostProcess,
    path,
    stateRef,
  });
  if (options.emitFirstUse) {
    yield* runFirstUse(stateRef, emit, persist);
  }
  yield* startTelemetryLifecycle({
    emit,
    exitFlushTimeout: EXIT_FLUSH_TIMEOUT,
    flush,
    flushInterval: FLUSH_INTERVAL,
    sessionStarted,
    sessionStartedAt,
  });
  return {
    emit,
    flush,
  };
});

/**
 * The live {@link Telemetry} adapter. Resolves the `ORI_TELEMETRY` opt-out and
 * builds the buffering/flush client, or a strict no-op when disabled: no
 * buffer, no network, no state file, no install-id creation.
 *
 * `HttpClient` is captured once at layer build (`makeLiveShape`) and threaded
 * into `postBatch` as a plain parameter, so it rides this layer's build-time
 * requirement channel — discharged by the CLI root, which outlives the exit-
 * flush finalizer. `Clock` is an Effect default service, leaving `FileSystem |
 * Path` (the state and version reads) plus `HostProcess`, `CliIo`, `Crypto`,
 * and `HttpClient` as the requirements.
 */
const make = Effect.fn("Telemetry.make")(function* (
  options: TelemetryLayerOptions
) {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  if (isDisabledEnvValue(env[TELEMETRY_ENV])) {
    return Telemetry.of(noopShape);
  }
  return Telemetry.of(
    yield* makeLiveShape(options).pipe(Effect.orElseSucceed(() => noopShape))
  );
});

export const makeTelemetryLive = (
  options: TelemetryLayerOptions
): TelemetryLiveLayer => Layer.effect(Telemetry)(make(options));

export const TelemetryLive = makeTelemetryLive({
  emitFirstUse: true,
});

/** Daemon telemetry shares the normal client lifecycle but has no CLI first-use side effects. */
export const TelemetryDaemonLive = makeTelemetryLive({
  emitFirstUse: false,
});
