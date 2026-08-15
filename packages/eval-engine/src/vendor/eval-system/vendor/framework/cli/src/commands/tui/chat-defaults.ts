import { Effect } from "effect";

import type { FeatureBootResult } from "../../../../runloop/local/src/feature-boot/types.ts";

import { DEFAULT_REASONING_EFFORT } from "../../../../contracts/author/src/index.ts";
import { HarnessName } from "../../../../contracts/internal/src/ids.ts";
import { formatBootDiagnostic } from "../../../../runloop/local/src/feature-boot/diagnostics.ts";

const describeBootErrors = (boot: FeatureBootResult): string | undefined => {
  const errors = boot.structuredDiagnostics
    .filter((diagnostic) => diagnostic.level === "error")
    .map((diagnostic) => `- ${formatBootDiagnostic(diagnostic)}`);
  return errors.length === 0
    ? undefined
    : ["feature boot has error diagnostics:", ...errors].join("\n");
};

// Kept separate from tui/command.ts so `routekit-eval dev`'s contribution runner can
// import it without dragging in the heavy chat/agent-runner subtree that module
// pulls via `makeChat`.
export const resolveChatDefaultsFromBoot = Effect.fn(
  "ChatDefaults.resolveChatDefaultsFromBoot"
)(function* (input: {
  readonly boot: FeatureBootResult | undefined;
  readonly harnessName: string | undefined;
  readonly model: string | null | undefined;
}) {
  const { boot, harnessName, model } = input;
  if (boot === undefined) {
    return {
      harness: harnessName,
      model,
      effort: DEFAULT_REASONING_EFFORT,
      bootDiagnostics: [] as readonly string[],
      warnings: [] as readonly string[],
    } as const;
  }
  const warnings: string[] = [];
  const bootDiagnostics = describeBootErrors(boot);
  // The harness whose default model backs the fallback must be the harness
  // that will actually run turns: the `--harness` flag's entry when named
  // (so `--harness claude` advertises claude's default model, not the boot
  // default's), otherwise the boot's optimistic default.
  const selectedHarness =
    harnessName === undefined
      ? yield* boot.harnessRegistry.default.pipe(
          Effect.orElseSucceed((): undefined => undefined)
        )
      : yield* boot.harnessRegistry.get(HarnessName.make(harnessName)).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              warnings.push(
                `harness "${harnessName}" isn't registered; its default model can't back the chat defaults`
              );
            })
          ),
          Effect.orElseSucceed((): undefined => undefined)
        );
  const harness = harnessName ?? selectedHarness?.name;
  const registryModel = boot.modelRegistry.resolve();
  const resolvedModel = model ?? registryModel ?? selectedHarness?.defaultModel;
  const usedHarnessFallback =
    (model === undefined || model === null) &&
    (registryModel === undefined || registryModel === null) &&
    selectedHarness?.defaultModel !== undefined;
  if (usedHarnessFallback && bootDiagnostics !== undefined) {
    warnings.push(
      `no workspace model resolved; falling back to harness "${selectedHarness?.name}" default model "${selectedHarness?.defaultModel}"`
    );
  }
  return {
    harness,
    model: resolvedModel,
    effort: DEFAULT_REASONING_EFFORT,
    bootDiagnostics: bootDiagnostics === undefined ? [] : [bootDiagnostics],
    warnings: warnings as readonly string[],
  } as const;
});
