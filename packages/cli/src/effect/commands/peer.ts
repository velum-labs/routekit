import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { decodeJoinCredential } from "@velum-labs/routekit-runtime/tokens";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { cliTry, cliTryPromise } from "../../cli-session.js";
import { assertPeerCredentialUsable } from "../../client.js";
import { resolveCredentialArgument } from "../../credentials.js";
import {
  deletePeerPointer,
  readDaemonPublicRecord,
  readPeerPointer,
  writePeerPointer
} from "../../peer.js";
import { assertLocalTarget } from "../../target.js";
import { routekitRoot } from "../root-command.js";

export const makePeerCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const add = Command.make(
    "add",
    { joinCredential: Argument.string("join-credential") },
    ({ joinCredential: input }) =>
      Effect.gen(function* () {
        assertLocalTarget("peer add");
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const joinCredential = yield* cliTryPromise(() => resolveCredentialArgument(input));
        const decoded = yield* cliTry(() => decodeJoinCredential(joinCredential));
        yield* assertPeerCredentialUsable({
          publicRecordPath: decoded.publicRecordPath,
          controlToken: decoded.token
        });
        const pointer = writePeerPointer({
          publicRecordPath: decoded.publicRecordPath,
          controlToken: decoded.token
        });
        const pub = readDaemonPublicRecord(pointer.publicRecordPath);
        if (ctx.json) {
          ctx.emit({
            peer: {
              publicRecordPath: pointer.publicRecordPath,
              addedAt: pointer.addedAt,
              controlUrl: pub.url,
              generation: pub.generation
            }
          });
          return;
        }
        ctx.presenter.success(`peer pointer stored → ${pub.url}`);
        ctx.presenter.note(
          "this account will not auto-start a local daemon; ask the owner to keep theirs running"
        );
      })
  ).pipe(
    Command.withDescription(
      "store a peer pointer from a self-describing join credential (pass - to read from stdin)"
    )
  );

  const show = Command.make("show", {}, () =>
    Effect.gen(function* () {
      assertLocalTarget("peer show");
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const pointer = readPeerPointer();
      if (pointer === undefined) {
        if (ctx.json) ctx.emit({ peer: null });
        else ctx.presenter.note("no peer pointer configured");
        return;
      }
      const outcome = yield* Effect.try({
        try: () => readDaemonPublicRecord(pointer.publicRecordPath),
        catch: (error) => (error instanceof Error ? error.message : String(error))
      }).pipe(Effect.result);
      const publicRecord = outcome._tag === "Success" ? outcome.success : undefined;
      const error = outcome._tag === "Failure" ? outcome.failure : undefined;
      if (ctx.json) {
        ctx.emit({
          peer: {
            publicRecordPath: pointer.publicRecordPath,
            addedAt: pointer.addedAt,
            ...(publicRecord !== undefined
              ? {
                  controlUrl: publicRecord.url,
                  generation: publicRecord.generation,
                  dataUrl: publicRecord.dataUrl
                }
              : {}),
            ...(error !== undefined ? { error } : {})
          }
        });
        return;
      }
      ctx.presenter.status("ok", "peer", pointer.publicRecordPath);
      if (publicRecord !== undefined) {
        ctx.presenter.status("ok", "control", publicRecord.url);
        if (publicRecord.dataUrl !== undefined) {
          ctx.presenter.status("ok", "data", publicRecord.dataUrl);
        }
      } else if (error !== undefined) {
        ctx.presenter.status("pending", "public-record", error);
      }
    })
  ).pipe(Command.withDescription("show the peer pointer and current public record"));

  const remove = Command.make("remove", {}, () =>
    Effect.gen(function* () {
      assertLocalTarget("peer remove");
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      if (readPeerPointer() === undefined) {
        if (ctx.json) ctx.emit({ removed: false });
        else ctx.presenter.note("no peer pointer configured");
        return;
      }
      deletePeerPointer();
      if (ctx.json) ctx.emit({ removed: true });
      else ctx.presenter.success("peer pointer removed");
    })
  ).pipe(Command.withDescription("remove the peer pointer from this account"));

  return Command.make("peer").pipe(
    Command.withDescription("point this account at another user's shared RouteKit daemon"),
    Command.withSubcommands([add, show, remove])
  );
};
