import { homedir } from "node:os";
import { resolve } from "node:path";

import { contextFor } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import {
  defaultPeerPublicRecordPath,
  deletePeerPointer,
  readDaemonPublicRecord,
  readPeerPointer,
  writePeerPointer
} from "../peer.js";
import { assertLocalTarget } from "../target.js";

export function registerPeer(program: Command): void {
  const peer = program
    .command("peer")
    .description("point this account at another user's shared RouteKit daemon");

  peer
    .command("add")
    .description("store a peer pointer (control token + public record path)")
    .requiredOption("--token <control-token>", "durable control-plane token from the owner")
    .option(
      "--public-record <path>",
      "absolute path to the owner's daemon.public.json"
    )
    .option(
      "--owner-home <path>",
      "owner home directory (derives the public record path)"
    )
    .action(
      (
        options: { token: string; publicRecord?: string; ownerHome?: string },
        command: Command
      ) => {
        assertLocalTarget("peer add");
        const ctx = contextFor(command);
        let publicRecordPath = options.publicRecord;
        if (publicRecordPath === undefined) {
          if (options.ownerHome === undefined) {
            throw new Error("provide --public-record <path> or --owner-home <path>");
          }
          publicRecordPath = defaultPeerPublicRecordPath(resolve(options.ownerHome));
        } else {
          publicRecordPath = resolve(publicRecordPath);
        }
        const pointer = writePeerPointer({
          publicRecordPath,
          controlToken: options.token
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
      }
    );

  peer
    .command("show")
    .description("show the peer pointer and current public record")
    .action((_options: unknown, command: Command) => {
      assertLocalTarget("peer show");
      const ctx = contextFor(command);
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
      const ctx = contextFor(command);
      if (readPeerPointer() === undefined) {
        if (ctx.json) ctx.emit({ removed: false });
        else ctx.presenter.note("no peer pointer configured");
        return;
      }
      deletePeerPointer();
      if (ctx.json) ctx.emit({ removed: true });
      else ctx.presenter.success("peer pointer removed");
    });

  peer
    .command("default-path")
    .description("print the default public-record path for an owner home")
    .argument("[owner-home]", "owner home directory", homedir())
    .action((ownerHome: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const path = defaultPeerPublicRecordPath(resolve(ownerHome));
      if (ctx.json) ctx.emit({ path });
      else process.stdout.write(`${path}\n`);
    });
}
