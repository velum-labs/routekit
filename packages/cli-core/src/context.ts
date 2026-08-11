import type {
  ChecklistController,
  KeyValueRow,
  LiveFrameController,
  Presenter,
  ProgressController,
  StatusKind,
  StepInput,
  TableOptions,
  TaskController
} from "@velum-labs/routekit-cli-ui";

import { createPresenter, PlainPresenter, stripAnsi } from "@velum-labs/routekit-cli-ui";
import type { Command } from "commander";

export type GlobalFlags = {
  json: boolean;
  yes: boolean;
  quiet: boolean;
  noInput: boolean;
};

export type CommandContext = GlobalFlags & {
  presenter: Presenter;
  emit(payload: unknown): void;
};

export type CliRuntime = Readonly<{
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  env: Readonly<NodeJS.ProcessEnv>;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
}>;

export const processCliRuntime: CliRuntime = Object.freeze({
  stdout: process.stdout,
  stderr: process.stderr,
  env: Object.freeze({ ...process.env }),
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.versions.node
});

export function immutableCliRuntime(runtime: CliRuntime): CliRuntime {
  return Object.freeze({
    ...runtime,
    env: Object.freeze({ ...runtime.env })
  });
}

export function emitJson(payload: unknown, runtime: CliRuntime = processCliRuntime): void {
  runtime.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

class QuietPresenter extends PlainPresenter {
  override banner(): void {}
  override header(): void {}
  override heading(): void {}
  override line(): void {}
  override blank(): void {}
  override note(): void {}
  override success(): void {}
  override status(kind: StatusKind, label: string, detail?: string, hint?: string): void {
    if (kind === "fail" || kind === "warn") super.status(kind, label, detail, hint);
  }
  override keyValue(_rows: readonly KeyValueRow[]): void {}
  override table(_rows: readonly (readonly string[])[], _options?: TableOptions): void {}
  override box(_title: string, _lines: readonly string[]): void {}
  override checklist(steps: readonly StepInput[]): ChecklistController {
    const labels = new Map(steps.map((step) => [step.id, step.label]));
    return {
      setActive: () => {},
      setDone: () => {},
      setFailed: (id, detail) =>
        this.error(`${labels.get(id) ?? id}${detail !== undefined ? ` ${detail}` : ""}`),
      setSkipped: () => {},
      setDetail: () => {},
      stop: () => {}
    };
  }
  override task(text: string): TaskController {
    return {
      update: () => {},
      succeed: () => {},
      fail: (line) => this.error(line ?? text),
      warn: (line) => this.warn(line ?? text),
      info: () => {},
      stop: () => {}
    };
  }
  override progress(label: string): ProgressController {
    return {
      update: () => {},
      succeed: () => {},
      fail: (line) => this.error(line ?? label),
      stop: () => {}
    };
  }
  override liveFrame(): LiveFrameController {
    return {
      render: () => {},
      renderError: (content) => {
        const lines = typeof content === "function" ? content() : content;
        this.error(lines.map((line) => stripAnsi(line)).join("\n"));
      },
      stop: () => {}
    };
  }
}

type RawGlobalOpts = { json?: boolean; yes?: boolean; quiet?: boolean; input?: boolean };

export function contextFor(
  command: Command,
  runtime: CliRuntime = processCliRuntime
): CommandContext {
  const opts = command.optsWithGlobals<RawGlobalOpts>();
  const json = opts.json === true;
  const quiet = opts.quiet === true;
  const noInput = opts.input === false;
  return {
    json,
    yes: opts.yes === true,
    quiet,
    noInput,
    presenter:
      json || quiet
        ? new QuietPresenter()
        : createPresenter(noInput ? { interactive: false } : undefined),
    emit: (payload) => emitJson(payload, runtime)
  };
}

export function attachGlobalFlags(program: Command): Command {
  return program
    .option("--json", "emit a machine-readable JSON result on stdout (implies non-interactive)")
    .option("--no-input", "never prompt; prompts resolve to their defaults")
    .option("--yes", "accept confirmations without asking")
    .option("--quiet", "suppress informational output (warnings and errors still print)");
}
