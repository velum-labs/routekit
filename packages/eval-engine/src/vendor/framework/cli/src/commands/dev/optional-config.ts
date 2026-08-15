import { Config, Effect, Option } from "effect";

export const readOptionalConfigString = (
  name: string
): Effect.Effect<string | undefined, Config.ConfigError> =>
  Config.string(name).pipe(
    Config.option,
    Effect.map((value) => (Option.isSome(value) ? value.value : undefined))
  );
