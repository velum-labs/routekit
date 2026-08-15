import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { parseProductArgv } from "./product-argv";
import { runSpawnWorkflow } from "./spawn-workflow";

export const evalSystemSpawnCommand = Command.make("spawn", {}, () =>
  Effect.promise(async () => {
    await runSpawnWorkflow(parseProductArgv().commandArgs.slice(1));
  }),
).pipe(
  Command.withDescription(
    "Drive the durable eval authoring interview: skill, manifest, prepare, run, answer, status. Relays one tagged question per turn and never answers for the user.",
  ),
);
