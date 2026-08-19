import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { randomId } from "@velum-labs/routekit-runtime/timing";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { remoteControlClient } from "../../adapters/ssh-control.js";
import { cliTry, cliTryPromise } from "../../cli-session.js";
import { routekitClient } from "../../client.js";
import { resolveTarget } from "../../target.js";
import { makeCredentialShellCommand } from "./credentials.js";
import { routekitRoot } from "../root-command.js";

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

const tokenClient = Effect.gen(function* () {
  const target = yield* cliTryPromise(() => resolveTarget());
  if (target.kind === "local") return yield* routekitClient;
  return yield* cliTry(() => remoteControlClient(target.remote));
});

export const makeTokensCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const issue = Command.make(
    "issue",
    {
      label: Argument.string("label"),
      plane: Flag.choice("plane", ["data", "control"] as const).pipe(
        Flag.withDefault("data"),
        Flag.withDescription("data or control")
      ),
      createdBy: optionalString("created-by").pipe(
        Flag.withDescription("optional creator label recorded in the registry")
      )
    },
    ({ createdBy, label, plane }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const client = yield* tokenClient;
        const result = yield* client.call(
          "tokens.issue",
          {
            label,
            plane,
            ...(createdBy !== undefined ? { createdBy } : {})
          },
          { idempotencyKey: `token-issue-${randomId(16)}` }
        );
        if (ctx.json) {
          ctx.emit(result);
          return;
        }
        ctx.presenter.success(`issued ${result.plane} token ${result.label} (${result.id})`);
        if (result.plane === "control" && result.joinCredential !== undefined) {
          runtime.stdout.write(`routekit peer add ${result.joinCredential}\n`);
          ctx.presenter.note(
            "paste that line on the peer account (or pass it to `remote add --join`); shown once"
          );
          return;
        }
        runtime.stdout.write(`${result.token}\n`);
        if (result.plane === "control") {
          ctx.presenter.note(
            "this daemon does not return a join credential; upgrade it before peers can enroll with `routekit peer add`"
          );
        } else {
          ctx.presenter.note("plaintext is shown once; store it now");
        }
      })
  ).pipe(Command.withDescription("issue a named token (plaintext shown once)"));

  const list = Command.make(
    "list",
    {
      plane: Flag.choice("plane", ["data", "control"] as const).pipe(
        Flag.optional,
        Flag.map(Option.getOrUndefined),
        Flag.withDescription("filter by data or control")
      )
    },
    ({ plane }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const client = yield* tokenClient;
        const result = yield* client.call("tokens.list", {
          ...(plane !== undefined ? { plane } : {})
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
      })
  ).pipe(Command.withDescription("list issued tokens (hashes only; no plaintext)"));

  const revoke = Command.make(
    "revoke",
    { id: Argument.string("id") },
    ({ id }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const client = yield* tokenClient;
        const result = yield* client.call(
          "tokens.revoke",
          { id },
          { idempotencyKey: `token-revoke-${randomId(16)}` }
        );
        if (ctx.json) ctx.emit(result);
        else ctx.presenter.success(`revoked token ${result.id} (${result.label})`);
      })
  ).pipe(Command.withDescription("revoke a named admin token (owner token cannot be revoked)"));

  return Command.make("token").pipe(
    Command.withDescription("issue, list, and revoke named gateway tokens"),
    Command.withSubcommands([
      makeCredentialShellCommand(runtime),
      issue,
      list,
      revoke
    ])
  );
};
