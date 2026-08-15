import { randomUUID } from "node:crypto";
import type {
  ResetCredit,
  ResetCreditSnapshot,
  SubscriptionMemberStatus,
  SubscriptionUsageResponse,
  SubscriptionUsageSource
} from "@velum-labs/routekit-accounts";
import {
  CliError,
  type CliRuntime,
  contextFor,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { confirm, renderErrorPanelLines, select } from "@velum-labs/routekit-cli-ui";
import type { Presenter } from "@velum-labs/routekit-cli-ui";
import { RouteKitControlClient } from "@velum-labs/routekit-control";
import type { Command } from "commander";
import { Cause, Effect, Exit } from "effect";
import { runCliClient, runCliEffect } from "../cli-session.js";
import { CliLive, DaemonClient } from "../effect/daemon-client.js";
import {
  availableResetCredits,
  formatExpiryCountdown,
  formatResetCreditHint,
  formatResetCreditsLine,
  formatResetCreditTitle,
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
  client: RouteKitControlClient,
  first: SubscriptionUsageResponse
): SubscriptionUsageSource {
  let prefetched: SubscriptionUsageResponse | undefined = first;
  return {
    usage: () => {
      if (prefetched !== undefined) {
        const usage = prefetched;
        prefetched = undefined;
        return Effect.succeed(usage);
      }
      return client.call("accounts.usage", {}) as ReturnType<SubscriptionUsageSource["usage"]>;
    },
    close: () => Effect.void
  };
}

function openSubscriptionUsageSourceEffect() {
  return DaemonClient.use((client) =>
    Effect.gen(function* () {
      const first = (yield* client.call("accounts.usage", {})) as SubscriptionUsageResponse;
      return daemonUsageSource(client, first);
    })
  ).pipe(
    Effect.mapError((error) =>
      unavailable(
        `Could not open enrolled subscription accounts: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    )
  );
}

export async function openSubscriptionUsageSource(): Promise<SubscriptionUsageSource> {
  return await runCliEffect(openSubscriptionUsageSourceEffect().pipe(Effect.provide(CliLive)));
}

function fetchSubscriptionUsageEffect() {
  return DaemonClient.use(
    (client) => client.call("accounts.usage", {}) as ReturnType<SubscriptionUsageSource["usage"]>
  );
}

export async function fetchSubscriptionUsage(): Promise<SubscriptionUsageResponse> {
  return await runCliEffect(fetchSubscriptionUsageEffect().pipe(Effect.provide(CliLive)));
}

function watchUsageEffect(
  presenter: Presenter,
  intervalSeconds: number,
  render: Effect.Effect<readonly string[], unknown, any>
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const frame = presenter.liveFrame();
      const localAbort = new AbortController();
      const onSigint = (): void => localAbort.abort();
      process.once("SIGINT", onSigint);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.removeListener("SIGINT", onSigint);
          frame.stop();
        })
      );
      const milliseconds = Math.max(0.1, intervalSeconds) * 1000;
      while (!localAbort.signal.aborted) {
        const exit = yield* Effect.exit(render);
        if (localAbort.signal.aborted) break;
        if (Exit.isSuccess(exit)) {
          frame.render([...exit.value]);
        } else {
          const content = usageErrorLines(Cause.squash(exit.cause));
          if (frame.renderError !== undefined) frame.renderError(content);
          else frame.render(content);
        }
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, milliseconds);
              const onAbort = (): void => {
                clearTimeout(timer);
                resolve();
              };
              if (localAbort.signal.aborted) {
                onAbort();
                return;
              }
              localAbort.signal.addEventListener("abort", onAbort, { once: true });
            }),
          catch: () => undefined
        });
      }
    })
  );
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

function codexMembers(usage: SubscriptionUsageResponse): SubscriptionMemberStatus[] {
  return usage.accountSets.find((accountSet) => accountSet.mode === "codex")?.members ?? [];
}

function enrolledCodexMember(
  members: SubscriptionMemberStatus[],
  label: string
): SubscriptionMemberStatus {
  const member = members.find((entry) => entry.label === label);
  if (member === undefined) {
    throw new CliError({
      code: "not_found",
      message: `codex/${label} is not enrolled`,
      tryCommand: "routekit accounts list"
    });
  }
  return member;
}

export function soonestResetCredit(credits: readonly ResetCredit[]): ResetCredit | undefined {
  return [...credits].sort((left, right) => {
    const expiry = (credit: ResetCredit) => credit.expiresAt ?? Number.POSITIVE_INFINITY;
    return expiry(left) - expiry(right) || left.id.localeCompare(right.id);
  })[0];
}

function withResetSnapshot(
  member: SubscriptionMemberStatus,
  resetCredits: ResetCreditSnapshot
): SubscriptionMemberStatus {
  return {
    ...member,
    limits:
      member.limits === undefined
        ? {
            windows: {},
            resetCredits,
            observedAt: resetCredits.observedAt,
            source: "usage",
            completeness: "partial"
          }
        : { ...member.limits, resetCredits }
  };
}

export async function chooseCodexMember(
  usage: SubscriptionUsageResponse,
  label: string | undefined,
  interactive: boolean
): Promise<SubscriptionMemberStatus> {
  const members = codexMembers(usage);
  if (members.length === 0) {
    throw new CliError({
      code: "subscription_usage_unavailable",
      message: "no codex accounts are enrolled",
      hint: "Enroll a Codex account first.",
      tryCommand: "routekit accounts login codex --name <label>"
    });
  }
  const explicit = label?.trim();
  if (explicit !== undefined && explicit.length > 0) return enrolledCodexMember(members, explicit);
  const eligible = members.filter(
    (member) => (member.limits?.resetCredits?.availableCount ?? 0) > 0
  );
  if (eligible.length === 0) {
    throw new CliError({
      code: "not_found",
      message: "no enrolled codex account has redeemable rate-limit resets",
      hint: "Banked resets appear in `routekit usage` when OpenAI grants them."
    });
  }
  if (eligible.length === 1) return eligible[0]!;
  if (!interactive) {
    throw new CliError({
      message: "multiple codex accounts have resets; pass --label <name>",
      tryCommand: "routekit usage redeem --provider codex --label <name> --yes"
    });
  }
  const selectedLabel = await select({
    message: "Choose a Codex account",
    options: eligible.map((member) => ({
      value: member.label,
      label: `codex/${member.label}`,
      hint: formatResetCreditsLine(member.limits) ?? "reset available"
    }))
  });
  return enrolledCodexMember(eligible, selectedLabel);
}

export async function chooseResetCreditId(
  member: SubscriptionMemberStatus,
  explicitCreditId: string | undefined,
  automated: boolean
): Promise<string | undefined> {
  const explicit = explicitCreditId?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const available = availableResetCredits(member.limits);
  if (available.length === 0) {
    if ((member.limits?.resetCredits?.availableCount ?? 0) <= 0) {
      throw new CliError({
        code: "not_found",
        message: `codex/${member.label} has no redeemable rate-limit resets`,
        hint: "Banked resets appear in `routekit usage` when OpenAI grants them."
      });
    }
    return undefined;
  }
  if (automated || available.length === 1) return soonestResetCredit(available)!.id;
  return select({
    message: "Choose a reset credit",
    options: available.map((credit) => ({
      value: credit.id,
      label: formatResetCreditTitle(credit),
      hint: formatResetCreditHint(credit)
    }))
  });
}

export function registerUsage(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const usage = program
    .command("usage")
    .description("show account rate limits, credits, and reset windows")
    .option("--watch [seconds]", "refresh continuously (default: 5 seconds)")
    .action(async (options: { watch?: string | boolean }, command: Command) => {
      const ctx = contextFor(command, runtime);
      if (options.watch !== undefined && ctx.json) {
        throw new CliError({
          message: "`usage --watch` is a live human view and cannot be combined with --json"
        });
      }
      if (options.watch !== undefined) {
        const interval = watchInterval(options.watch);
        await runCliEffect(
          Effect.gen(function* () {
            const source = yield* openSubscriptionUsageSourceEffect();
            yield* watchUsageEffect(
              ctx.presenter,
              interval,
              source.usage().pipe(Effect.map((snapshot) => renderUsageLines(snapshot)))
            ).pipe(Effect.ensuring(source.close().pipe(Effect.ignore)));
          }).pipe(Effect.provide(CliLive))
        );
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
        const ctx = contextFor(command, runtime);
        if (options.provider !== "codex") {
          throw new CliError({
            message: "only --provider codex supports redeemable rate-limit resets"
          });
        }
        if (!ctx.yes && (ctx.json || ctx.noInput)) {
          throw new CliError({
            message: "`usage redeem` requires --yes in non-interactive mode"
          });
        }
        const snapshot = await fetchSubscriptionUsage();
        const memberFromUsage = await chooseCodexMember(
          snapshot,
          options.label,
          !ctx.yes && !ctx.json && !ctx.noInput
        );
        const member = withResetSnapshot(
          memberFromUsage,
          (
            await runCliClient((client) =>
              client.call("accounts.resetCredits", { kind: "codex", label: memberFromUsage.label })
            )
          ).resetCredits
        );
        const creditId = await chooseResetCreditId(
          member,
          options.creditId,
          ctx.yes || ctx.json || ctx.noInput
        );
        const selected =
          creditId === undefined
            ? undefined
            : (availableResetCredits(member.limits).find((credit) => credit.id === creditId) ??
              (member.limits?.resetCredits?.credits ?? []).find(
                (credit) => credit.id === creditId
              ));
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
                : "credit: provider will choose (details are count-only)",
            selected?.expiresAt !== undefined
              ? `expiry: ${formatExpiryCountdown(selected.expiresAt)}`
              : "expiry: unknown",
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
        if (ctx.yes && creditId === undefined) {
          ctx.presenter.line("reset details are count-only; provider will choose the credit");
        }
        const result = await runCliClient((client) =>
          client.call("accounts.redeemReset", {
            kind: "codex",
            label: member.label,
            redeemRequestId,
            ...(creditId !== undefined ? { creditId } : {})
          })
        );
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
