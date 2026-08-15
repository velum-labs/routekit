import { Effect } from "effect";
import { ChildProcess } from "effect/unstable/process";

interface BrowserCommand {
  readonly args: readonly string[];
  readonly command: string;
}

export const browserCommand = (
  platform: NodeJS.Platform,
  url: string
): BrowserCommand => {
  if (platform === "darwin") {
    return {
      args: [url],
      command: "open",
    };
  }
  if (platform === "win32") {
    return {
      args: ["/c", "start", "", url],
      command: "cmd",
    };
  }
  return {
    args: [url],
    command: "xdg-open",
  };
};

/**
 * Best-effort open of the system browser. Failures are swallowed so the printed
 * authorization URL stays usable when no browser is available. The launcher
 * (`open`/`xdg-open`/`start`) exits immediately after handing off to the
 * browser, so awaiting its exit code does not block the flow.
 */
export const openBrowser = Effect.fn("openBrowser")(function* (url: string) {
  yield* Effect.gen(function* () {
    const { args, command } = browserCommand(process.platform, url);
    const handle = yield* ChildProcess.make(command, [...args], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
    yield* handle.exitCode;
  }).pipe(Effect.scoped, Effect.ignore);
});
