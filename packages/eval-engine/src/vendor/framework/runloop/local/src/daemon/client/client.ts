import { Context, Effect, Layer, Stream } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { RuntimeCommand } from "../../../../../contracts/internal/src/runtime/command-types.ts";
import type { RuntimeClientOptions } from "./client-http.ts";

import {
  RuntimeClientError,
  RuntimeProtocolError,
} from "../../../../../contracts/internal/src/errors.ts";
import { isOkStatus } from "../../../../../contracts/internal/src/http-client.ts";
import { decodeJsonLine } from "../../../../../contracts/internal/src/json.ts";
import { RuntimeStreamEventSchema } from "../../../../../contracts/internal/src/runtime/stream-event.ts";
import {
  decodeRuntimeNdjsonLines,
  fetchRuntimeHealth,
  makeRuntimeClientErrorFromCause,
  makeRuntimeUrl,
  readDaemonError,
  readResponseText,
} from "./client-http.ts";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
} from "../core/http-defaults.ts";

const NOT_FOUND_STATUS = 404;
const INVOKE_PATH = "/api/invoke";
const decodeRuntimeStreamEventJsonLine = decodeJsonLine(
  RuntimeStreamEventSchema
);

type RuntimeStreamEvent =
  ReturnType<typeof decodeRuntimeStreamEventJsonLine> extends Effect.Effect<
    infer Event,
    unknown,
    unknown
  >
    ? Event
    : never;

interface RuntimeClientShape {
  readonly health: Effect.Effect<
    void,
    RuntimeClientError,
    HttpClient.HttpClient
  >;
  readonly invoke: (
    command: RuntimeCommand
  ) => Stream.Stream<
    RuntimeStreamEvent,
    RuntimeClientError | RuntimeProtocolError,
    HttpClient.HttpClient
  >;
  readonly url: (path: string) => string;
}

class RuntimeClientConfig extends Context.Service<
  RuntimeClientConfig,
  RuntimeClientOptions
>()("ori/runtime/RuntimeClientConfig") {
  /**
   * Direct-binding factory: a `RuntimeClientConfig` from a host/port the caller
   * already holds, bypassing the `Config`/env read. Distinct from
   * {@link RuntimeClientConfig.layerTest}: `fromOptions` binds a real endpoint a
   * caller passes in, whereas `layerTest` fills the daemon defaults for a stub.
   * The env-reading implementation lives in the `RuntimeClientConfigLive` adapter
   * (`daemon-client-live.ts`).
   */
  static readonly fromOptions = (
    options: RuntimeClientOptions
  ): Layer.Layer<RuntimeClientConfig> =>
    Layer.succeed(RuntimeClientConfig)(RuntimeClientConfig.of(options));

  /**
   * Test seam: a `RuntimeClientConfig` bound to the daemon defaults
   * (`DEFAULT_DAEMON_HOST` / `DEFAULT_DAEMON_PORT`). Override `host`/`port` for a
   * case that needs a specific endpoint; the effectful implementation that reads
   * `ORI_RUNTIME_HOST` / `ORI_RUNTIME_PORT` lives in the `RuntimeClientConfigLive`
   * adapter (`daemon-client-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<RuntimeClientOptions>
  ): Layer.Layer<RuntimeClientConfig> =>
    Layer.succeed(RuntimeClientConfig)(
      RuntimeClientConfig.of({
        host: DEFAULT_DAEMON_HOST,
        port: DEFAULT_DAEMON_PORT,
        ...impl,
      })
    );
}

const decodeRuntimeStreamEventLine = Effect.fn(
  "RuntimeClient.decodeStreamEvent"
)(function* (line: string) {
  return yield* decodeRuntimeStreamEventJsonLine(line).pipe(
    Effect.mapError(
      (cause) =>
        new RuntimeProtocolError({
          cause,
          detail: "Invalid runtime stream event",
        })
    )
  );
});

const formatInvokeNotFoundError = (
  options: RuntimeClientOptions,
  body: string
): string =>
  `Runtime invoke failed with HTTP 404 at ${makeRuntimeUrl(options, INVOKE_PATH)}. The runtime is reachable, but it does not expose the invoke endpoint; restart ori start from the current checkout and retry the local TUI. Response: ${body}`;

const postRuntimeCommand = Effect.fn("RuntimeClient.postRuntimeCommand")(
  function* (options: RuntimeClientOptions, command: RuntimeCommand) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(makeRuntimeUrl(options, INVOKE_PATH), {
          body: HttpBody.jsonUnsafe(command),
        })
      )
      .pipe(
        Effect.mapError(
          makeRuntimeClientErrorFromCause(
            `Failed to invoke local Ori runtime at ${makeRuntimeUrl(options, INVOKE_PATH)}`
          )
        )
      );

    if (isOkStatus(response.status)) {
      return response.stream.pipe(
        Stream.mapError(
          makeRuntimeClientErrorFromCause(
            `Failed to read local Ori runtime stream at ${makeRuntimeUrl(options, INVOKE_PATH)}`
          )
        )
      );
    }

    const body = yield* readResponseText(options, INVOKE_PATH, response);
    if (response.status === NOT_FOUND_STATUS) {
      return yield* new RuntimeClientError({
        detail: formatInvokeNotFoundError(options, body),
      });
    }
    const { cause, summary } = yield* readDaemonError(body);
    return yield* new RuntimeClientError({
      cause,
      detail: `Runtime invoke failed with HTTP ${response.status}: ${summary}`,
    });
  }
);

const readRuntimeNdjson = (
  bytes: Stream.Stream<Uint8Array, RuntimeClientError>
): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeClientError | RuntimeProtocolError
> =>
  decodeRuntimeNdjsonLines(bytes).pipe(
    Stream.mapEffect(decodeRuntimeStreamEventLine)
  );

export const invokeRuntime = (
  options: RuntimeClientOptions,
  command: RuntimeCommand
): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeClientError | RuntimeProtocolError,
  HttpClient.HttpClient
> =>
  Stream.unwrap(
    postRuntimeCommand(options, command).pipe(Effect.map(readRuntimeNdjson))
  );

export class RuntimeClient extends Context.Service<
  RuntimeClient,
  RuntimeClientShape
>()("ori/runtime/RuntimeClient") {
  /**
   * Test seam: a `RuntimeClient` with inert defaults — `health` succeeds,
   * `invoke` yields an empty stream, and `url` builds a default-endpoint URL.
   * Override only the methods a case exercises; the effectful implementation that
   * talks HTTP to the daemon lives in the `RuntimeClientLive` adapter
   * (`daemon-client-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<RuntimeClientShape>
  ): Layer.Layer<RuntimeClient> =>
    Layer.succeed(RuntimeClient)(
      RuntimeClient.of({
        health: Effect.void,
        invoke: () => Stream.empty,
        url: (path) =>
          makeRuntimeUrl(
            {
              host: DEFAULT_DAEMON_HOST,
              port: DEFAULT_DAEMON_PORT,
            },
            path
          ),
        ...impl,
      })
    );
}

export const makeRuntimeClient = (
  options: RuntimeClientOptions
): RuntimeClientShape =>
  RuntimeClient.of({
    health: fetchRuntimeHealth(options),
    invoke: (command) => invokeRuntime(options, command),
    url: (path) => makeRuntimeUrl(options, path),
  });

export { RuntimeClientConfig };
export type { RuntimeClientShape };
