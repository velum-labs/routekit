import { Context, Data, Effect, Layer, Option } from "effect";

export class HostProcessCommandNotFound extends Data.TaggedError(
  "HostProcessCommandNotFound"
)<{
  readonly command: string;
}> {}

export class HostProcessExecFailed extends Data.TaggedError(
  "HostProcessExecFailed"
)<{
  readonly command: string;
  readonly detail: string;
}> {}

export interface HostProcessExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/**
 * The host process boundary: the executable path, working directory, process
 * environment, and home directory the CLI runs against, plus a mutator for the
 * environment. This is a pure port — the effectful implementation that reads the
 * real process/OS globals lives in the `@routekit-eval-engine/runtime-io` adapter
 * (`host-process.ts`), and {@link HostProcess.layerTest} provides a deterministic
 * stand-in for tests.
 */
export interface HostProcessShape {
  readonly currentExecutablePath: Effect.Effect<Option.Option<string>>;
  readonly currentWorkingDirectory: Effect.Effect<string>;
  /**
   * Resolves an executable name to an absolute path via the host PATH so
   * subprocess spawns avoid PATH lookup errors from non-directory entries.
   */
  readonly resolveExecutablePath: (
    command: string
  ) => Effect.Effect<Option.Option<string>>;
  /**
   * The live adapter returns a direct reference to the process environment, not
   * a snapshot: mutating the resolved object mutates the real process env. Read
   * it, do not retain and mutate it.
   */
  readonly env: Effect.Effect<NodeJS.ProcessEnv>;
  readonly homeDirectory: Effect.Effect<string>;
  readonly setEnv: (
    name: string,
    value: string | undefined
  ) => Effect.Effect<void>;
  readonly execDestructivelyReplacingCurrentProcess: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
  }) => Effect.Effect<
    never,
    HostProcessCommandNotFound | HostProcessExecFailed
  >;
}

export class HostProcess extends Context.Service<
  HostProcess,
  HostProcessShape
>()("routekit-eval/runtime/HostProcess") {
  /**
   * Test seam: a `HostProcess` with inert deterministic defaults. Override only
   * the fields a case cares about; unset fields report no executable, `/tmp` for
   * cwd and home, an empty environment, and a no-op `setEnv`. For a test that
   * observes env reads or writes, pass a coupled `env`/`setEnv` pair backed by
   * one object (or the live process env) so a write is visible on a later read.
   */
  static readonly layerTest = (
    impl: Partial<HostProcessShape> & {
      readonly execRequests?: HostProcessExecRequest[];
    }
  ): Layer.Layer<HostProcess> => {
    const { execRequests, ...overrides } = impl;
    return Layer.succeed(HostProcess)(
      HostProcess.of({
        currentExecutablePath: Effect.succeed(Option.none<string>()),
        currentWorkingDirectory: Effect.succeed("/tmp"),
        resolveExecutablePath: () => Effect.succeed(Option.none<string>()),
        env: Effect.succeed({}),
        homeDirectory: Effect.succeed("/tmp"),
        setEnv: () => Effect.void,
        execDestructivelyReplacingCurrentProcess: (input) => {
          execRequests?.push({
            command: input.command,
            args: [...input.args],
            env: { ...input.env },
          });
          return Effect.fail(
            new HostProcessExecFailed({
              command: input.command,
              detail: "HostProcess test layer captured the exec request",
            })
          );
        },
        ...overrides,
      })
    );
  };
}
