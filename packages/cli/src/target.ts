import type { Command } from "commander";
import { activeCliSession, type CliSession, type TargetSelection } from "./cli-session.js";
import type { RouteKitRemote } from "./remotes.js";

export type RouteKitTarget =
  | { kind: "local" }
  | { kind: "remote"; remote: RouteKitRemote; authToken: string };

export function setTargetSelection(next: TargetSelection, session: CliSession): void {
  session.targetSelection = next.local ? { local: true } : next;
}

export function setTargetSelectionFromCommand(command: Command, session: CliSession): void {
  const options = command.optsWithGlobals<{ local?: boolean; remote?: string }>();
  setTargetSelection(
    {
      local: options.local === true,
      ...(options.remote !== undefined ? { remote: options.remote } : {})
    },
    session
  );
}

export function selectedRemoteMetadata(): RouteKitRemote | undefined {
  const session = activeCliSession();
  const selection = session.targetSelection;
  if (selection.local) return undefined;
  if (selection.remote !== undefined) {
    const remote = session.remotes.registry.find(selection.remote);
    if (remote === undefined) throw new Error(`unknown RouteKit remote: ${selection.remote}`);
    return remote;
  }
  return session.remotes.registry.active();
}

export async function resolveTarget(): Promise<RouteKitTarget> {
  const session = activeCliSession();
  const remote = selectedRemoteMetadata();
  if (remote === undefined) return { kind: "local" };
  const authToken = await session.remotes.credentials.read(remote.name);
  if (authToken === undefined) {
    throw new Error(
      `no gateway token is stored for remote "${remote.name}"; run \`routekit remote add ${remote.name} --url ${remote.gatewayUrl} --ssh ${remote.sshHost}\``
    );
  }
  return { kind: "remote", remote, authToken };
}

export function assertLocalTarget(operation: string): void {
  const session = activeCliSession();
  const selection = session.targetSelection;
  if (!selection.local && selection.remote !== undefined) {
    const remote = session.remotes.registry.find(selection.remote);
    if (remote === undefined) {
      throw new Error(
        `${operation} is local-only; pass --local or run it directly on the intended remote host`
      );
    }
  }
  const remote = selectedRemoteMetadata();
  if (remote === undefined) return;
  throw new Error(
    `${operation} manages the local daemon; run it on the remote with \`ssh ${remote.sshHost} routekit ${operation}\` or pass --local`
  );
}
