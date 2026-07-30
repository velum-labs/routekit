import { contextFor } from "@velum-labs/routekit-cli-core";
import { confirm } from "@velum-labs/routekit-cli-ui";
import type { Command } from "commander";

import { routekitToolRegistry } from "../launch.js";
import { deleteSession, getSession, listSessions, type RouteKitSession } from "../sessions.js";

function targetLabel(session: RouteKitSession): string {
  return session.target.kind === "local" ? "local" : `remote:${session.target.name}`;
}

function emitSession(command: Command, session: RouteKitSession): void {
  const ctx = contextFor(command);
  if (ctx.json) {
    ctx.emit(session);
    return;
  }
  ctx.presenter.heading(session.id);
  ctx.presenter.keyValue([
    { label: "tool", value: session.tool },
    { label: "status", value: session.status },
    { label: "model", value: session.model },
    { label: "cwd", value: session.cwd },
    { label: "repository", value: session.repository.root },
    { label: "target", value: targetLabel(session) },
    { label: "updated", value: session.updatedAt }
  ]);
}

export function registerSessions(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("list and manage RouteKit-native session metadata");

  sessions
    .command("list", { isDefault: true })
    .description("list RouteKit-managed sessions")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const entries = listSessions().sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      );
      if (ctx.json) {
        ctx.emit({ sessions: entries });
        return;
      }
      if (entries.length === 0) {
        ctx.presenter.note("no RouteKit sessions");
        return;
      }
      if (process.stdout.isTTY) {
        ctx.presenter.table(
          entries.map((entry) => [
            entry.id,
            entry.tool,
            entry.status,
            entry.model,
            targetLabel(entry),
            entry.cwd
          ]),
          { head: ["id", "tool", "status", "model", "target", "cwd"] }
        );
      } else {
        for (const entry of entries) {
          process.stdout.write(
            `${entry.id}\t${entry.tool}\t${entry.status}\t${entry.model}\t${targetLabel(entry)}\t${entry.cwd}\n`
          );
        }
      }
    });

  sessions
    .command("show <id>")
    .description("show one RouteKit-managed session")
    .action((id: string, _options: unknown, command: Command) => {
      const session = getSession(id);
      if (session === undefined) throw new Error(`unknown RouteKit session: ${id}`);
      emitSession(command, session);
    });

  sessions
    .command("rm <id>")
    .alias("remove")
    .description("remove a native session and its RouteKit metadata")
    .action(async (id: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const session = getSession(id);
      if (session === undefined) throw new Error(`unknown RouteKit session: ${id}`);
      const integration = routekitToolRegistry.get(session.tool);
      if (integration === undefined || integration.session.status === "unsupported") {
        throw new Error(
          `${session.tool} does not support managed session removal; remove its native session manually, then delete the RouteKit registry entry if needed`
        );
      }
      const exactDelete = integration.session.removal === "exact-delete";
      if (!ctx.json && !exactDelete) {
        ctx.presenter.warn(
          `RouteKit can only forget ${id}; the native ${integration.displayName} conversation will remain on disk`
        );
      }
      if (!ctx.yes) {
        if (ctx.noInput || ctx.json) {
          throw new Error(`refusing to remove ${id} without confirmation; pass --yes`);
        }
        const accepted = await confirm({
          message: exactDelete
            ? `Permanently delete native ${integration.displayName} session ${id}?`
            : `Forget RouteKit metadata for ${id}?`,
          defaultValue: false
        });
        if (!accepted) {
          ctx.presenter.note("session metadata was not removed");
          return;
        }
      }
      if (integration.session.removal === "exact-delete") {
        await integration.session.removeNative(session.resume as Parameters<typeof integration.session.removeNative>[0], {
          env: process.env,
          cwd: session.cwd
        });
      }
      await deleteSession(id);
      const nativeSessionRemoved = integration.session.removal === "exact-delete";
      if (ctx.json) ctx.emit({ removed: true, id, nativeSessionRemoved });
      else if (nativeSessionRemoved) ctx.presenter.success(`removed native session and RouteKit metadata for ${id}`);
      else ctx.presenter.success(`forgot RouteKit session ${id}`);
    });
}
