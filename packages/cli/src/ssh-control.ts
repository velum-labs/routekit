import { RouteKitControlClient } from "@velum-labs/routekit-control";
import { ControlError, type ControlTransport } from "@velum-labs/routekit-runtime";

import { RELAY_SCRIPT } from "./generated/shell-scripts.js";
import type { RouteKitRemote } from "./remotes.js";
import {
  classifySshFailure,
  remoteShellArgv,
  requestSecrets,
  runSshCommand,
  sshExitError
} from "./ssh-exec.js";
import { routekitVersion } from "./state.js";

/** `exec` hands the relay's stdin and stdout straight to the remote CLI. */

type RelayResult = {
  status: number;
  body: unknown;
};

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
  const transport: ControlTransport = {
    health: async (signal) => {
      const result = await runSshRelay(remote, { kind: "health" }, {
        timeoutMs: 90_000,
        signal
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" }
      });
    },
    call: async (request, signal) => {
      const result = await runSshRelay(remote, { kind: "call", request }, {
        timeoutMs: 90_000,
        signal
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" }
      });
    },
    stream: async (request, signal) => {
      const result = await runSshRelay(remote, { kind: "call", request }, {
        timeoutMs: 90_000,
        signal
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" }
      });
    }
  };
  return new RouteKitControlClient({
    packageVersion: routekitVersion(),
    cwd: process.cwd(),
    timeoutMs: 90_000,
    transport
  });
}
