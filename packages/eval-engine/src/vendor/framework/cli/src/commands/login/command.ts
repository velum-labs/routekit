import { Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import type { RunLoginOptions } from "./login.ts";

import { reportCommandFailure } from "../../command-failure.ts";
import { runLogin } from "./login.ts";

interface LoginCommandConfig {
  readonly callbackPort: Option.Option<number>;
  readonly local: boolean;
  readonly noBrowser: boolean;
}

const toRunLoginOptions = (config: LoginCommandConfig): RunLoginOptions => ({
  callbackPort: Option.getOrUndefined(config.callbackPort),
  noBrowser: config.noBrowser,
  scope: config.local ? "workspace" : "workspace-preferred",
});

const localFlag = Flag.boolean("local").pipe(
  Flag.withDescription(
    "Require saving the API key to this repo's .ori/credentials.json"
  )
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Print the sign-in URL instead of opening a browser")
);
const callbackPortFlag = Flag.integer("callback-port").pipe(
  Flag.withDescription(
    "Localhost port for the OAuth callback (default: random open port)"
  ),
  Flag.optional
);

export const loginCommand = Command.make(
  "login",
  {
    callbackPort: callbackPortFlag,
    local: localFlag,
    noBrowser: noBrowserFlag,
  },
  (config) =>
    runLogin(toRunLoginOptions(config)).pipe(reportCommandFailure("login"))
).pipe(
  Command.withDescription(
    "Sign in to OpenRouter through the browser and save an API key. Skip it entirely by exporting OPENROUTER_API_KEY: an inherited key wins over anything login stores"
  )
);

export { toRunLoginOptions };
export type { LoginCommandConfig };
