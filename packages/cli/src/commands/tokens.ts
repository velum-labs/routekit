import { contextFor } from "@velum-labs/routekit-cli-core";
import { randomId } from "@velum-labs/routekit-runtime";
import type { Command } from "commander";

import { routekitClient } from "../client.js";

export function registerTokens(program: Command): void {
  const token = program
    .command("token")
    .description("issue, list, and revoke named gateway tokens");

  token
    .command("issue <label>")
    .description("issue a named token (plaintext shown once)")
    .option("--plane <plane>", "data or control", "data")
    .option("--created-by <who>", "optional creator label recorded in the registry")
    .action(
      async (
        label: string,
        options: { plane?: string; createdBy?: string },
        command: Command
      ) => {
        const ctx = contextFor(command);
        const plane = options.plane === "control" ? "control" : "data";
        if (options.plane !== undefined && options.plane !== "data" && options.plane !== "control") {
          throw new Error("--plane must be data or control");
        }
        const result = await (await routekitClient()).call(
          "tokens.issue",
          {
            label,
            plane,
            ...(options.createdBy !== undefined ? { createdBy: options.createdBy } : {})
          },
          { idempotencyKey: `token-issue-${randomId(16)}` }
        );
        if (ctx.json) {
          ctx.emit(result);
          return;
        }
        ctx.presenter.success(`issued ${result.plane} token ${result.label} (${result.id})`);
        if (result.plane === "control" && result.joinCredential !== undefined) {
          process.stdout.write(`routekit peer add ${result.joinCredential}\n`);
          ctx.presenter.note(
            "paste that line on the peer account (or pass it to `remote add --join`); shown once"
          );
          return;
        }
        process.stdout.write(`${result.token}\n`);
        if (result.plane === "control") {
          ctx.presenter.note(
            "this daemon does not return a join credential; upgrade it before peers can enroll with `routekit peer add`"
          );
          return;
        }
        ctx.presenter.note("plaintext is shown once; store it now");
      }
    );

  token
    .command("list")
    .description("list issued tokens (hashes only; no plaintext)")
    .option("--plane <plane>", "filter by data or control")
    .action(async (options: { plane?: string }, command: Command) => {
      const ctx = contextFor(command);
      if (
        options.plane !== undefined &&
        options.plane !== "data" &&
        options.plane !== "control"
      ) {
        throw new Error("--plane must be data or control");
      }
      const result = await (await routekitClient()).call("tokens.list", {
        ...(options.plane !== undefined
          ? { plane: options.plane as "data" | "control" }
          : {})
      });
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      if (result.tokens.length === 0) {
        ctx.presenter.note("no tokens");
        return;
      }
      for (const entry of result.tokens) {
        const state = entry.revokedAt !== undefined ? "revoked" : "active";
        ctx.presenter.status(
          state === "active" ? "ok" : "pending",
          entry.id,
          `${entry.plane}/${entry.role} ${entry.label} (${state})`
        );
      }
    });

  token
    .command("revoke <id>")
    .description("revoke a named admin token (owner token cannot be revoked)")
    .action(async (id: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await (await routekitClient()).call(
        "tokens.revoke",
        { id },
        { idempotencyKey: `token-revoke-${randomId(16)}` }
      );
      if (ctx.json) ctx.emit(result);
      else ctx.presenter.success(`revoked token ${result.id} (${result.label})`);
    });
}
