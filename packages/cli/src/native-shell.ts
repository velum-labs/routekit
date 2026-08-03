import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const BEGIN = "# >>> routekit native credentials >>>";
const END = "# <<< routekit native credentials <<<";

function shellRcFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.ROUTEKIT_SHELL_RC?.trim();
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const shell = basename(env.SHELL ?? "");
  if (shell === "zsh") return resolve(env.HOME ?? homedir(), ".zshrc");
  if (shell === "bash") return resolve(env.HOME ?? homedir(), ".bashrc");
  return undefined;
}

export function nativeShellBlock(): string {
  return [
    BEGIN,
    "# RouteKit stores native client credentials outside shell configuration.",
    "# This block is managed by `routekit codex install` / `routekit claude install`.",
    "if command -v routekit >/dev/null 2>&1; then",
    '  eval "$(routekit token shell 2>/dev/null)"',
    "fi",
    END
  ].join("\n");
}

function replaceBlock(content: string, block: string, path: string): string {
  const begin = content.indexOf(BEGIN);
  if (begin === -1) {
    const normalized = content.replace(/\s+$/, "");
    return normalized.length === 0 ? `${block}\n` : `${normalized}\n\n${block}\n`;
  }
  const end = content.indexOf(END, begin);
  if (end === -1) {
    throw new Error(
      `found the RouteKit shell integration marker but no end marker in ${JSON.stringify(
        path
      )}; remove the "${BEGIN}" line and its managed block, then retry`
    );
  }
  return `${content.slice(0, begin)}${block}${content.slice(end + END.length)}`;
}

function removeBlock(content: string): string {
  const begin = content.indexOf(BEGIN);
  if (begin === -1) return content;
  const end = content.indexOf(END, begin);
  if (end === -1) return content;
  const before = content.slice(0, begin).replace(/\s+$/, "");
  const after = content.slice(end + END.length).replace(/^\s+/, "");
  if (before.length === 0 && after.length === 0) return "";
  if (before.length === 0) return `${after}\n`;
  if (after.length === 0) return `${before}\n`;
  return `${before}\n\n${after}\n`;
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to modify symlinked shell startup file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function installNativeShellIntegration(
  shellPath = shellRcFromEnvironment()
): string | undefined {
  if (shellPath === undefined) return undefined;
  assertNotSymlink(shellPath);
  const content = existsSync(shellPath) ? readFileSync(shellPath, "utf8") : "";
  const next = replaceBlock(content, nativeShellBlock(), shellPath);
  if (next !== content) writeFileSync(shellPath, next, { mode: 0o600 });
  return shellPath;
}

export function uninstallNativeShellIntegration(shellPath: string): boolean {
  const path = resolve(shellPath);
  if (!existsSync(path)) return false;
  assertNotSymlink(path);
  const content = readFileSync(path, "utf8");
  const next = removeBlock(content);
  if (next === content) return false;
  writeFileSync(path, next, { mode: 0o600 });
  return true;
}

export function defaultNativeShellPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return shellRcFromEnvironment(env);
}
