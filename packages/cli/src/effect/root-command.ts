import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

export const routekitRoot = Command.make("routekit").pipe(
  Command.withSharedFlags({
    json: Flag.boolean("json").pipe(
      Flag.withDescription("emit a machine-readable JSON result on stdout (implies non-interactive)")
    ),
    noInput: Flag.boolean("no-input").pipe(
      Flag.withDescription("never prompt; prompts resolve to their defaults")
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withDescription("accept confirmations without asking")
    ),
    quiet: Flag.boolean("quiet").pipe(
      Flag.withDescription("suppress informational output (warnings and errors still print)")
    ),
    local: Flag.boolean("local").pipe(
      Flag.withDescription("force the local RouteKit daemon")
    ),
    remote: optionalString("remote").pipe(
      Flag.withDescription("target a named remote gateway")
    )
  }),
  Command.withDescription("configure and run model routes for coding tools")
);

export type RouteKitGlobalFlags = Effect.Success<typeof routekitRoot>;
