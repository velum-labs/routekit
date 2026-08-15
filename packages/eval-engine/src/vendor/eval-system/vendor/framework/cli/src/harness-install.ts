import { Effect } from "effect";
import { Prompt } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CliIo } from "../../contracts/internal/src/cli/cli-io.ts";
import {
  formatHint,
  formatInfo,
} from "../../contracts/internal/src/cli/cli-messages.ts";
import { HostProcess } from "../../contracts/internal/src/cli/host-process.ts";
import { isInteractiveTerminal } from "./interactive-terminal.ts";

/**
 * The coding agents `routekit-eval` can launch, and can offer to install. This is the one
 * source of truth: {@link HARNESS_INSTALL_RECIPES} is keyed by it, and
 * `agent-launch.ts` derives both its launch kind and its argv splitter from it,
 * so a new agent cannot be half-added.
 */
export const LAUNCHABLE_HARNESSES = [
  "claude",
  "codex",
  "opencode",
  "hermes",
] as const;

export type HarnessInstallKind = (typeof LAUNCHABLE_HARNESSES)[number];

export interface HarnessInstallMethod {
  /** Short column label, e.g. `Homebrew`. */
  readonly label: string;
  /** The exact shell command a user can copy and paste. */
  readonly command: string;
}

export interface HarnessInstallRecipe {
  readonly kind: HarnessInstallKind;
  /** How the agent's own docs name it, e.g. `Claude Code`. */
  readonly displayName: string;
  readonly docsUrl: string;
  /**
   * The method RouteKitEval offers to run for the user. Every recipe's script installs
   * under `$HOME` without sudo; where an installer wants root for optional
   * system extras (Hermes and its ripgrep/ffmpeg step) it asks on the inherited
   * terminal and degrades when refused, so RouteKitEval never elevates on its own.
   */
  readonly recommended: HarnessInstallMethod;
  /** Other documented methods, printed but never run. */
  readonly alternatives: readonly HarnessInstallMethod[];
  /**
   * Where the installer drops the binary. Prepended to `PATH` after an install
   * so the immediate relaunch finds the command without a new shell.
   */
  readonly binDirs: readonly string[];
}

const PATH_SEPARATOR = ":";
const PATH_ENV = "PATH";
const SUCCESS_EXIT_CODE = 0;
const SPAWN_FAILURE_EXIT_CODE = -1;
const DOCS_LABEL = "Docs";

export const HARNESS_INSTALL_RECIPES: Record<
  HarnessInstallKind,
  HarnessInstallRecipe
> = {
  claude: {
    kind: "claude",
    displayName: "Claude Code",
    docsUrl: "https://code.claude.com/docs/en/setup",
    recommended: {
      label: "Install script",
      command: "curl -fsSL https://claude.ai/install.sh | bash",
    },
    alternatives: [
      {
        label: "Homebrew",
        command: "brew install --cask claude-code",
      },
      {
        label: "npm",
        command: "npm install -g @anthropic-ai/claude-code",
      },
    ],
    binDirs: [".local/bin"],
  },
  codex: {
    kind: "codex",
    displayName: "Codex CLI",
    docsUrl: "https://developers.openai.com/codex/cli",
    recommended: {
      label: "Install script",
      command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    },
    alternatives: [
      {
        label: "Homebrew",
        command: "brew install --cask codex",
      },
      {
        label: "npm",
        command: "npm install -g @openai/codex",
      },
    ],
    binDirs: [".local/bin"],
  },
  opencode: {
    kind: "opencode",
    displayName: "opencode",
    docsUrl: "https://opencode.ai/docs",
    recommended: {
      label: "Install script",
      command: "curl -fsSL https://opencode.ai/install | bash",
    },
    alternatives: [
      {
        label: "Homebrew",
        command: "brew install anomalyco/tap/opencode",
      },
      {
        label: "npm",
        command: "npm i -g opencode-ai@latest",
      },
    ],
    binDirs: [".opencode/bin", ".local/bin"],
  },
  hermes: {
    kind: "hermes",
    displayName: "Hermes",
    docsUrl:
      "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
    recommended: {
      label: "Install script",
      command:
        "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    },
    alternatives: [],
    binDirs: [".local/bin", ".hermes/bin"],
  },
};

const allMethods = (
  recipe: HarnessInstallRecipe
): readonly HarnessInstallMethod[] => [
  {
    ...recipe.recommended,
    label: `${recipe.recommended.label} (quickest)`,
  },
  ...recipe.alternatives,
  {
    label: DOCS_LABEL,
    command: recipe.docsUrl,
  },
];

/**
 * The install block every `routekit-eval <harness>` prints when the binary is missing:
 * the same shape for all four agents, quickest method first, docs last.
 */
export const formatHarnessInstallMethods = (
  recipe: HarnessInstallRecipe
): string => {
  const methods = allMethods(recipe);
  let labelWidth = 0;
  for (const method of methods) {
    labelWidth = Math.max(labelWidth, method.label.length);
  }
  const rows = methods.map(
    (method) => `  ${method.label.padEnd(labelWidth)}  ${method.command}`
  );
  return [
    formatInfo(
      `${recipe.displayName} is not installed. Install it with one of these:`
    ),
    ...rows,
  ].join("\n");
};

export const harnessInstallHint = (recipe: HarnessInstallRecipe): string =>
  `Install ${recipe.displayName} with \`${recipe.recommended.command}\`, then run \`routekit-eval ${recipe.kind}\` again. Docs: ${recipe.docsUrl}`;

export const makeHarnessInstallShellArgs = (
  recipe: HarnessInstallRecipe
): readonly string[] => ["-o", "pipefail", "-c", recipe.recommended.command];

export const prependPathEntries = (
  pathValue: string | undefined,
  entries: readonly string[]
): string => {
  const existing =
    pathValue
      ?.split(PATH_SEPARATOR)
      .filter((part) => part.length > 0 && !entries.includes(part)) ?? [];
  return [...entries, ...existing].join(PATH_SEPARATOR);
};

const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/u, "");

export const resolveHarnessBinDirs = (
  recipe: HarnessInstallRecipe,
  homeDirectory: string
): readonly string[] => {
  const home = trimTrailingSlashes(homeDirectory);
  return recipe.binDirs.map((dir) => `${home}/${dir}`);
};

const addHarnessBinDirsToPath = Effect.fn("HarnessInstall.addBinDirsToPath")(
  function* (recipe: HarnessInstallRecipe) {
    const hostProcess = yield* HostProcess;
    const env = yield* hostProcess.env;
    const home = yield* hostProcess.homeDirectory;
    yield* hostProcess.setEnv(
      PATH_ENV,
      prependPathEntries(env[PATH_ENV], resolveHarnessBinDirs(recipe, home))
    );
  }
);

/**
 * Run the recommended installer with the terminal inherited, so the installer's
 * own stdout/stderr (and any prompt it raises) reaches the user unfiltered.
 */
const runHarnessInstaller = Effect.fn("HarnessInstall.runInstaller")(function* (
  recipe: HarnessInstallRecipe
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .exitCode(
      ChildProcess.make("bash", makeHarnessInstallShellArgs(recipe), {
        extendEnv: true,
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      })
    )
    .pipe(Effect.orElseSucceed(() => SPAWN_FAILURE_EXIT_CODE));
});

/**
 * Print the install methods, then (on an interactive terminal only) offer to run
 * the recommended one. Returns `true` when the installer succeeded, so the
 * caller can retry the launch. A non-TTY or CI run gets the methods and no
 * prompt.
 */
export const offerHarnessInstall = Effect.fn("HarnessInstall.offer")(function* (
  recipe: HarnessInstallRecipe
) {
  const cliIo = yield* CliIo;
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  yield* cliIo
    .writeStderr(`${formatHarnessInstallMethods(recipe)}\n`)
    .pipe(Effect.ignore);

  if (
    !isInteractiveTerminal({
      env,
      isStdinTty: yield* cliIo.isStdinTty,
    })
  ) {
    return false;
  }

  const shouldInstall = yield* Prompt.confirm({
    message: `Run \`${recipe.recommended.command}\` now?`,
  });
  if (!shouldInstall) {
    return false;
  }

  const exitCode = yield* runHarnessInstaller(recipe);
  if (exitCode !== SUCCESS_EXIT_CODE) {
    yield* cliIo
      .writeStderr(
        `${formatHint(`${recipe.displayName} installer did not finish (exit code ${exitCode}). Try another method above.`)}\n`
      )
      .pipe(Effect.ignore);
    return false;
  }

  yield* addHarnessBinDirsToPath(recipe);
  return true;
});
