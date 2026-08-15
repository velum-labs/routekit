import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const EMPTY_COUNT = 0;

/**
 * Resolve a command name against PATH, matching the previous HostProcess
 * `which` contract.
 *
 * Absolute or slash-containing names are returned unchanged (the caller is
 * already pointing at a path). A missing binary returns `undefined`.
 */
export const resolveExecutablePath = (
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (isAbsolute(binary) || binary.includes("/")) {
    return binary;
  }
  const entries = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length !== EMPTY_COUNT);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const entry of entries) {
    for (const extension of extensions) {
      const suffix =
        extension.length === EMPTY_COUNT ||
        binary.toLowerCase().endsWith(extension.toLowerCase())
          ? ""
          : extension;
      const candidate = join(entry, `${binary}${suffix}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not executable here; keep searching.
      }
    }
  }
  return undefined;
};
