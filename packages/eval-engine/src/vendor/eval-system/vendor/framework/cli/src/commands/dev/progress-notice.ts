// Progress notices the dev/daemon path prints while it gets ready: installing
// dependencies, restarting after that install, falling back to the global
// workspace, opening an event log.
//
// They are for a person watching a terminal, and they are NOT command output. In
// json mode the envelope has to be the only thing on stdout, because that is what
// makes `routekit-eval eval --json | jq` work, so a notice printed there turns a valid
// document into a parse error for whoever is reading it. `routekit-eval eval` boots this
// same daemon path, and a workspace whose dependencies are not installed yet hits
// it on its very first run, which is exactly when an agent is most likely to be
// the one reading.
//
// Routing rather than suppressing: a human running with `--json` still wants to
// know an install is happening, and stderr is where that belongs.
import { Effect, Option } from "effect";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { OutputMode } from "../../../../contracts/internal/src/cli/output-mode.ts";

/**
 * Read the mode without demanding it. Several commands on this path never resolve
 * one (`routekit-eval start` among them), and requiring the service here would push a layer
 * into every one of their wirings for a notice. No resolved mode means nobody
 * asked for json, which is the human case, so stdout stays correct.
 */
export const writeProgressNotice = Effect.fn("DevProgress.notice")(function* (
  text: string
) {
  const cliIo = yield* CliIo;
  const resolved = yield* Effect.serviceOption(OutputMode);
  const isJson = Option.isSome(resolved) && resolved.value.mode === "json";
  yield* isJson ? cliIo.writeStderr(text) : cliIo.writeStdout(text);
});
