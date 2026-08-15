import { Effect, Schema } from "effect";

import { hasResolvableGatewayCredential } from "../login/credentials.ts";

/**
 * What `routekit-eval init` did, for a caller that reads the outcome instead of the
 * banner. `signedIn` is the field the headless flow branches on: it is the only
 * thing left to do before the workspace can call a model, and a hint printed to
 * a terminal is not something an agent should have to parse.
 */
const InitProjectResult = Schema.Struct({
  workspaceRoot: Schema.String,
  name: Schema.String,
  global: Schema.Boolean,
  /** `created` scaffolded a new workspace; `synced` refreshed an existing one. */
  outcome: Schema.Literals(["created", "synced"]),
  installed: Schema.Boolean,
  signedIn: Schema.Boolean,
});

type InitProjectResult = typeof InitProjectResult.Type;

/**
 * Resolves `signedIn` after the work rather than from the credential gate, so
 * it is accurate on every path: the gate is skipped entirely on a sync and under
 * `skipCredentialGate`, and an interactive login during the gate has to be
 * reflected too.
 */
const describeInitResult = Effect.fn("ProjectInit.describeResult")(
  function* (input: {
    readonly global: boolean;
    readonly installed: boolean;
    readonly name: string;
    readonly outcome: InitProjectResult["outcome"];
    readonly projectRoot: string;
  }) {
    const signedIn = yield* hasResolvableGatewayCredential({
      startDir: input.projectRoot,
    }).pipe(Effect.orElseSucceed(() => false));
    return {
      global: input.global,
      installed: input.installed,
      name: input.name,
      outcome: input.outcome,
      signedIn,
      workspaceRoot: input.projectRoot,
    } satisfies InitProjectResult;
  }
);

export { describeInitResult, InitProjectResult };
