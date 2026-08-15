// Dev runs `node .../routekit-eval.ts` so the entry script must be in argv; compiled
// single-binary installs take subcommands directly.

interface RouteKitEvalExecutable {
  /** `process.execPath`: the node binary, or the compiled routekit-eval executable. */
  readonly execPath: string;
  /** The entry script (`process.argv[1]`), or the exec path when compiled. */
  readonly main: string;
}

export const routeKitEvalChildArgvFrom = (
  executable: RouteKitEvalExecutable,
  args: readonly string[]
): readonly string[] => {
  const isCompiledBinary = executable.main === executable.execPath;
  return isCompiledBinary
    ? [executable.execPath, ...args]
    : [executable.execPath, executable.main, ...args];
};

export const routeKitEvalChildArgv = (args: readonly string[]): readonly string[] =>
  routeKitEvalChildArgvFrom(
    {
      execPath: process.execPath,
      main: process.argv[1] ?? process.execPath,
    },
    args
  );

export type { RouteKitEvalExecutable };
