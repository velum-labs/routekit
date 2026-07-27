import type {
  SubscriptionMemberStatus,
  SubscriptionUsageResponse,
  SubscriptionUsageSource
} from "@velum-labs/routekit-accounts";
import { CliError, contextFor } from "@velum-labs/routekit-cli-core";
import { confirm, renderErrorPanelLines, watch } from "@velum-labs/routekit-cli-ui";
import type { Command } from "commander";
import { randomUUID } from "node:crypto";

import { routekitClient } from "../client.js";
import {
  availableResetCredits,
  formatResetCreditsLine,
  renderUsageLines
} from "../usage-format.js";

const TRY_DOCTOR = "routekit doctor";

function unavailable(message: string): CliError {
  return new CliError({
    code: "subscription_usage_unavailable",
    message,
    hint: "Check enrolled subscription accounts and provider connectivity.",
    tryCommand: TRY_DOCTOR
  });
}

function daemonUsageSource(
  client: Awaited<ReturnType<typeof routekitClient>>,
  first: SubscriptionUsageResponse
): SubscriptionUsageSource {
  let prefetched: SubscriptionUsageResponse | undefined = first;
  return {
    usage: async () => {
      if (prefetched !== undefined) {
        const usage = prefetched;
        prefetched = undefined;
        return usage;
      }
      return (await client.call("accounts.usage", {})) as SubscriptionUsageResponse;
    },
    close: async () => {}
  };
}

export async function openSubscriptionUsageSource(): Promise<SubscriptionUsageSource> {
  try {
    const client = await routekitClient();
    const first = (await client.call("accounts.usage", {})) as SubscriptionUsageResponse;
    return daemonUsageSource(client, first);
  } catch (error) {
    throw unavailable(
      `Could not open enrolled subscription accounts: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function fetchSubscriptionUsage(): Promise<SubscriptionUsageResponse> {
  const source = await openSubscriptionUsageSource();
  try {
    return await source.usage();
  } finally {
    await source.close();
  }
}

function watchInterval(value: string | boolean): number {
  if (value === true) return 5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 86_400) {
    throw new CliError({ message: "watch interval must be between 0.1 and 86400 seconds" });
  }
  return parsed;
}

function usageErrorLines(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  return renderErrorPanelLines({
    title: "usage unavailable",
    message,
    hint: "Check enrolled subscription accounts and provider connectivity.",
    tryCommand: TRY_DOCTOR
  });
}

function resolveCodexMember(
  usage: SubscriptionUsageResponse,
  label: string | undefined
): SubscriptionMemberStatus {
  const set = usage.accountSets.find((accountSet) => accountSet.mode === "codex");
  const members = set?.members ?? [];
  if (members.length === 0) {
    throw new CliError({
      code: "subscription_usage_unavailable",
      message: "no codex accounts are enrolled",
      hint: "Enroll a Codex account first.",
      tryCommand: "routekit accounts login codex --name <label>"
    });
  }
  if (label !== undefined && label.trim().length > 0) {
    const member = members.find((entry) => entry.label === label.trim());
    if (member === undefined) {
      throw new CliError({
        code: "not_found",
        message: `codex/${label.trim()} is not enrolled`,
        tryCommand: "routekit accounts list"
      });
    }
    return member;
  }
  if (members.length === 1) return members[0]!;
  throw new CliError({
    message: "multiple codex accounts are enrolled; pass --label <name>",
    tryCommand: "routekit usage redeem --provider codex --label <name>"
  });
}

function pickResetCreditId(
  member: SubscriptionMemberStatus,
  creditId: string | undefined
): string | undefined {
  if (creditId !== undefined && creditId.trim().length > 0) return creditId.trim();
  const available = availableResetCredits(member.limits);
  if (available.length === 0) {
    const count = member.limits?.resetCredits?.availableCount ?? 0;
    if (count <= 0) {
      throw new CliError({
        code: "not_found",
        message: `codex/${member.label} has no redeemable rate-limit resets`,
        hint: "Banked resets appear in `routekit usage` when OpenAI grants them."
      });
    }
    // Count known but no detail rows — let the daemon auto-select.
    return undefined;
  }
  return [...available].sort((left, right) => {
    const leftExpiry = left.expiresAt ?? Number.POSITIVE_INFINITY;
    const rightExpiry = right.expiresAt ?? Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry;
  })[0]!.id;
}

export function registerUsage(program: Command): void {
  const usage = program
    .command("usage")
    .description("show account rate limits, credits, and reset windows")
    .option("--watch [seconds]", "refresh continuously (default: 5 seconds)")
    .action(async (options: { watch?: string | boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (options.watch !== undefined && ctx.json) {
        throw new CliError({
          message: "`usage --watch` is a live human view and cannot be combined with --json"
        });
      }
      if (options.watch !== undefined) {
        const source = await openSubscriptionUsageSource();
        try {
          await watch(
            ctx.presenter,
            watchInterval(options.watch),
            async () => renderUsageLines(await source.usage()),
            { errorFrame: usageErrorLines }
          );
        } finally {
          await source.close();
        }
        return;
      }
      try {
        const snapshot = await fetchSubscriptionUsage();
        if (ctx.json) ctx.emit(snapshot);
        else for (const line of renderUsageLines(snapshot)) ctx.presenter.line(line);
      } catch (error) {
        if (ctx.json || !(error instanceof CliError)) throw error;
        ctx.presenter.errorPanel({
          message: error.message,
          hint: error.hint,
          tryCommand: error.tryCommand
        });
        process.exitCode = error.exitCode;
      }
    });

  usage
    .command("redeem")
    .description("redeem a banked Codex rate-limit reset for an enrolled account")
    .requiredOption("--provider <provider>", "subscription provider (only codex)")
    .option("--label <label>", "enrolled account label")
    .option("--credit-id <id>", "specific reset credit id to redeem")
    .action(
      async (
        options: { provider: string; label?: string; creditId?: string },
        command: Command
      ) => {
        const ctx = contextFor(command);
        if (options.provider !== "codex") {
          throw new CliError({
            message: "only --provider codex supports redeemable rate-limit resets"
          });
        }
        const snapshot = await fetchSubscriptionUsage();
        const member = resolveCodexMember(snapshot, options.label);
        const creditId = pickResetCreditId(member, options.creditId);
        const selected = creditId === undefined
          ? undefined
          : availableResetCredits(member.limits).find((credit) => credit.id === creditId) ??
            (member.limits?.resetCredits?.credits ?? []).find((credit) => credit.id === creditId);
        if (!ctx.yes && (ctx.json || ctx.noInput)) {
          throw new CliError({
            message: "`usage redeem` requires --yes in non-interactive mode"
          });
        }
        if (!ctx.yes) {
          const summary =
            formatResetCreditsLine(member.limits) ??
            (creditId !== undefined ? creditId : "one available reset");
          const details = [
            `account: codex/${member.label}`,
            selected !== undefined
              ? `credit: ${selected.id}${selected.title !== undefined ? ` (${selected.title})` : ""}`
              : creditId !== undefined
                ? `credit: ${creditId}`
                : "credit: auto-select soonest-expiring",
            `banked: ${summary}`
          ];
          for (const line of details) ctx.presenter.line(line);
          const accepted = await confirm({
            message: "Redeem this rate-limit reset now?",
            defaultValue: false
          });
          if (!accepted) {
            throw new CliError({ message: "redeem cancelled", exitCode: 1 });
          }
        }
        const redeemRequestId = randomUUID();
        const client = await routekitClient();
        const result = await client.call("accounts.redeemReset", {
          kind: "codex",
          label: member.label,
          redeemRequestId,
          ...(creditId !== undefined ? { creditId } : {})
        });
        if (ctx.json) {
          ctx.emit(result);
          if (!result.ok) process.exitCode = 1;
          return;
        }
        if (!result.ok) {
          ctx.presenter.errorPanel({
            message: `reset redeem returned code ${result.code}`,
            hint: "The banked reset was not consumed; local cooldowns were left unchanged.",
            tryCommand: "routekit usage"
          });
          process.exitCode = 1;
          return;
        }
        ctx.presenter.line(
          `redeemed ${result.creditId ?? creditId ?? "reset"} on codex/${result.label} (code=${result.code})`
        );
        for (const line of renderUsageLines(result.usage as SubscriptionUsageResponse)) {
          ctx.presenter.line(line);
        }
      }
    );
}
