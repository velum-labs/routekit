import { RouteKitControlClient } from "@velum-labs/routekit-control";
import { ControlError } from "@velum-labs/routekit-runtime";

import type { RouteKitRemote } from "./remotes.js";
import {
  classifySshFailure,
  REMOTE_PATH_PREAMBLE,
  remoteShellArgv,
  requestSecrets,
  runSshCommand,
  sshExitError
} from "./ssh-exec.js";
import { routekitVersion } from "./state.js";

/** `exec` hands the relay's stdin and stdout straight to the remote CLI. */
const RELAY_SCRIPT = [
  REMOTE_PATH_PREAMBLE,
  "exec routekit --local --quiet daemon exec"
].join("\n");

type RelayResult = {
  status: number;
  body: unknown;
};

function response(result: RelayResult): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json" }
  });
}

function relayError(error: unknown, host: string, secrets: Iterable<string>): never {
  const failure = classifySshFailure(error, secrets);
  if (failure.missingSshClient) {
    throw new ControlError({
      code: "unavailable",
      message: "ssh was not found on PATH; install an SSH client to administer remote gateways"
    });
  }
  throw new ControlError({
    code: failure.code,
    message:
      `RouteKit remote control over SSH to ${host} failed` +
      (failure.detail.length > 0 ? `: ${failure.detail}` : "")
  });
}

export async function runSshRelay(
  remote: Pick<RouteKitRemote, "sshHost">,
  request: unknown,
  input: { timeoutMs?: number; signal?: AbortSignal | null } = {}
): Promise<RelayResult> {
  try {
    const result = await runSshCommand(
      remote.sshHost,
      remoteShellArgv(RELAY_SCRIPT),
      {
        timeoutMs: input.timeoutMs ?? 90_000,
        signal: input.signal ?? null,
        stdin: `${JSON.stringify(request)}\n`
      }
    );
    if (result.exitCode !== 0) throw sshExitError(result, remote.sshHost);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new ControlError({
        code: "unavailable",
        message: `RouteKit remote returned invalid JSON over SSH from ${remote.sshHost}`
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Number.isInteger((parsed as { status?: unknown }).status) ||
      ((parsed as { status: number }).status < 200 ||
        (parsed as { status: number }).status > 599) ||
      !("body" in parsed)
    ) {
      throw new ControlError({
        code: "unavailable",
        message: `RouteKit remote returned an invalid control envelope from ${remote.sshHost}`
      });
    }
    return parsed as RelayResult;
  } catch (error) {
    if (error instanceof ControlError) throw error;
    relayError(error, remote.sshHost, requestSecrets(request));
  }
}

export function remoteControlClient(remote: RouteKitRemote): RouteKitControlClient {
  const fetchOverSsh: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url
    );
    const body =
      url.pathname.endsWith("/health")
        ? { kind: "health" }
        : {
            kind: "call",
            request: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown
          };
    return response(
      await runSshRelay(remote, body, {
        timeoutMs: 90_000,
        signal: init?.signal
      })
    );
  };
  return new RouteKitControlClient({
    url: "http://127.0.0.1",
    token: "ssh-relay",
    packageVersion: routekitVersion(),
    cwd: process.cwd(),
    timeoutMs: 90_000,
    fetch: fetchOverSsh
  });
}
