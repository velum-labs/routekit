// Dev runs `node .../ori.ts` so the entry script must be in argv; compiled
// single-binary installs take subcommands directly.

interface OriExecutable {
  /** `process.execPath`: the node binary, or the compiled ori executable. */
  readonly execPath: string;
  /** The entry script (`process.argv[1]`), or the exec path when compiled. */
  readonly main: string;
}

export const oriChildArgvFrom = (
  executable: OriExecutable,
  args: readonly string[]
): readonly string[] => {
  const isCompiledBinary = executable.main === executable.execPath;
  return isCompiledBinary
    ? [executable.execPath, ...args]
    : [executable.execPath, executable.main, ...args];
};

export const oriChildArgv = (args: readonly string[]): readonly string[] =>
  oriChildArgvFrom(
    {
      execPath: process.execPath,
      main: process.argv[1] ?? process.execPath,
    },
    args
  );

export type { OriExecutable };
