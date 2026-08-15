import { Effect, Stream } from "effect";

import type { AcpConnectionError } from "../../acp-client/src/errors.ts";
import type {
  AcpClientRequestParams,
  AcpConnectionShape,
} from "../../acp-client/src/service.ts";
import type { SelectedAdapterError } from "../../selected-adapter/src/inventory.ts";

const sessionSetup = (
  cwd: string,
  sessionId: string
): {
  readonly additionalDirectories: readonly string[];
  readonly cwd: string;
  readonly mcpServers: readonly [];
  readonly sessionId: string;
} => ({
  additionalDirectories: [],
  cwd,
  mcpServers: [],
  sessionId,
});

const sessionLoadSetup = (
  cwd: string,
  sessionId: string
): AcpClientRequestParams<"session/load"> => sessionSetup(cwd, sessionId);

const sessionResumeSetup = (
  cwd: string,
  sessionId: string
): AcpClientRequestParams<"session/resume"> => sessionSetup(cwd, sessionId);

const resumeSessionRequest = (
  connection: AcpConnectionShape,
  mapConnectionError: (error: AcpConnectionError) => SelectedAdapterError,
  setup: { readonly cwd: string; readonly sessionId: string }
): Effect.Effect<void, SelectedAdapterError> =>
  // `session/load` replays the history as notifications, so the fallback has to
  // go through the draining path; a plain request leaves that replay with no
  // consumer and the history is lost. `session/resume` is not a
  // notification-producing method, so it stays a plain request.
  connection.capabilities.pipe(
    Effect.flatMap(({ agent }) =>
      agent.sessionCapabilities.resume === undefined ||
      agent.sessionCapabilities.resume === null
        ? connection
            .requestNotifications(
              "session/load",
              sessionLoadSetup(setup.cwd, setup.sessionId)
            )
            .pipe(Stream.runDrain)
        : connection.request(
            "session/resume",
            sessionResumeSetup(setup.cwd, setup.sessionId)
          )
    ),
    Effect.asVoid,
    Effect.mapError(mapConnectionError)
  );

export { resumeSessionRequest, sessionLoadSetup, sessionResumeSetup };
