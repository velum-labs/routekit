import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { decodeJoinCredential } from "@velum-labs/routekit-runtime/tokens";
import type { Command } from "commander";
import { Effect } from "effect";
import { cliTryPromise, runCliEffect } from "../cli-session.js";
import { assertPeerCredentialUsable } from "../client.js";
import { resolveCredentialArgument } from "../credentials.js";
import {
  deletePeerPointer,
  readDaemonPublicRecord,
  readPeerPointer,
  writePeerPointer
} from "../peer.js";
import { assertLocalTarget } from "../target.js";

export function registerPeer(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const peer = program
    .command("peer")
    .description("point this account at another user's shared RouteKit daemon");

  peer
    .command("add <join-credential>")
    .description(
      "store a peer pointer from a self-describing join credential (pass - to read from stdin)"
    )
    .action(async (joinCredentialArg: string, _options: unknown, command: Command) => {
      assertLocalTarget("peer add");
      const ctx = contextFor(command, runtime);
      const decoded = await runCliEffect(
        Effect.gen(function* () {
          const joinCredential = yield* cliTryPromise(() =>
            resolveCredentialArgument(joinCredentialArg)
          );
          const parsed = decodeJoinCredential(joinCredential);
          yield* assertPeerCredentialUsable({
            publicRecordPath: parsed.publicRecordPath,
            controlToken: parsed.token
          });
          return parsed;
        })
      );
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
    });

  peer
    .command("show")
    .description("show the peer pointer and current public record")
    .action((_options: unknown, command: Command) => {
      assertLocalTarget("peer show");
      const ctx = contextFor(command, runtime);
      const pointer = readPeerPointer();
      if (pointer === undefined) {
        if (ctx.json) ctx.emit({ peer: null });
        else ctx.presenter.note("no peer pointer configured");
        return;
      }
      let publicRecord: ReturnType<typeof readDaemonPublicRecord> | undefined;
      let error: string | undefined;
      try {
        publicRecord = readDaemonPublicRecord(pointer.publicRecordPath);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
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
    });

  peer
    .command("remove")
    .description("remove the peer pointer from this account")
    .action((_options: unknown, command: Command) => {
      assertLocalTarget("peer remove");
      const ctx = contextFor(command, runtime);
      if (readPeerPointer() === undefined) {
        if (ctx.json) ctx.emit({ removed: false });
        else ctx.presenter.note("no peer pointer configured");
        return;
      }
      deletePeerPointer();
      if (ctx.json) ctx.emit({ removed: true });
      else ctx.presenter.success("peer pointer removed");
    });
}
