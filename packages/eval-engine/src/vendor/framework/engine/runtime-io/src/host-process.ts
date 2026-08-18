import { homedir } from "node:os";

import { layer as NodePathLayer } from "@effect/platform-node/NodePath";
import { Effect, Layer, Option, Path } from "effect";

import { resolveExecutablePath } from "../../../../../runtime/which.ts";
import {
  HostProcess,
  HostProcessCommandNotFound,
  HostProcessExecFailed,
} from "../../../contracts/internal/src/cli/host-process.ts";
import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

/**
 * The live {@link HostProcess} adapter: the single sanctioned boundary that
 * reads the real process argv/env and OS home directory. The working directory
 * is read through Effect's `Path` service (`NodePath` is provided internally, so
 * the layer's requirement channel stays `never`), which keeps the raw-platform
 * surface to `process.argv`, `process.env`, and `homedir`. Globals are reached
 * through `globalThis.process` rather than the bare `process` identifier because
 * the repo's `node/no-process-env` lint bans a direct `process.env`, and
 * `globalThis` is the cast-free way to read it. Under Bun `setEnv(name,
 * undefined)` leaves the key present on the process env but reads back as
 * `undefined`; it neither deletes the key nor coerces to a string.
 */
const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  return HostProcess.of({
    currentExecutablePath: Effect.sync(() =>
      Option.fromUndefinedOr(globalThis.process.argv[1])
    ),
    currentWorkingDirectory: Effect.sync(() => path.resolve()),
    resolveExecutablePath: (command) =>
      Effect.sync(() => Option.fromNullishOr(resolveExecutablePath(command))),
    env: Effect.sync(() => globalThis.process.env),
    homeDirectory: Effect.sync(() => homedir()),
    setEnv: (name, value) =>
      Effect.sync(() => {
        globalThis.process.env[name] = value;
      }),
    execDestructivelyReplacingCurrentProcess: ({ command, args, env }) =>
      Effect.gen(function* () {
        const resolved = resolveExecutablePath(command);
        if (resolved === undefined) {
          return yield* new HostProcessCommandNotFound({ command });
        }
        const { execve } = globalThis.process;
        if (execve === undefined) {
          return yield* new HostProcessExecFailed({
            command,
            detail: "process.execve is unavailable in this runtime",
          });
        }
        return yield* Effect.try({
          // Bind `this` to `process` explicitly: `execve` is read off the
          // process object, so an unbound call could misbehave if the runtime's
          // implementation relies on its receiver.
          try: () =>
            execve.call(globalThis.process, resolved, [resolved, ...args], env),
          catch: (cause) =>
            new HostProcessExecFailed({
              command,
              detail: formatUnknownError(cause),
            }),
        });
      }),
  });
});

export const HostProcessLive: Layer.Layer<HostProcess> = Layer.effect(
  HostProcess
)(make).pipe(Layer.provide(NodePathLayer));
