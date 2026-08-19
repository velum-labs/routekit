import {
  commandNames,
  commandOptions,
  visibleCommandChildren
} from "@velum-labs/routekit-cli-core";
import type * as Command from "effect/unstable/cli/Command";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
type CommandNode = { names: string[]; subcommands: string[] };
export type CompletionValueProvider = (
  path: readonly string[],
  argumentDepth: number,
  positional: readonly string[]
) => readonly string[] | undefined;

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

export function visibleCommandNames(command: Command.Command.Any): string[] {
  return visibleCommandChildren(command).flatMap((entry) => [...commandNames(entry)]);
}

function visibleLongFlags(commands: readonly Command.Command.Any[]): string[] {
  const flags = new Set<string>();
  for (const command of commands) {
    for (const option of commandOptions(command)) {
      if (option.hidden) continue;
      flags.add(`--${option.name}`);
      for (const alias of option.aliases) flags.add(alias.length === 1 ? `-${alias}` : `--${alias}`);
    }
  }
  return [...flags];
}

export function filterCompletionCandidates(
  candidates: readonly string[],
  currentWord: string
): string[] {
  return [...new Set(candidates)]
    .filter((candidate) => candidate.startsWith(currentWord))
    .sort((left, right) => left.localeCompare(right));
}

function walkCompletionTree(program: Command.Command.Any, words: readonly string[]) {
  const typed = [...words];
  const currentWord = typed.pop() ?? "";
  let command = program;
  const ancestry: Command.Command.Any[] = [program];
  const path: string[] = [];
  const positional: string[] = [];
  let argumentDepth = 0;
  for (const word of typed) {
    if (word.startsWith("-")) continue;
    const next = visibleCommandChildren(command).find((entry) => commandNames(entry).includes(word));
    if (next !== undefined) {
      command = next;
      ancestry.push(next);
      path.push(next.name);
      argumentDepth = 0;
    } else {
      positional.push(word);
      argumentDepth += 1;
    }
  }
  return { command, ancestry, path, positional, argumentDepth, currentWord };
}

export function completionCandidates(
  program: Command.Command.Any,
  words: readonly string[],
  dynamicValues?: CompletionValueProvider
): string[] {
  const state = walkCompletionTree(program, words);
  const candidates = state.currentWord.startsWith("-")
    ? visibleLongFlags(state.ancestry)
    : [
        ...visibleCommandNames(state.command),
        ...(dynamicValues?.(state.path, state.argumentDepth, state.positional) ?? [])
      ];
  return filterCompletionCandidates(candidates, state.currentWord);
}

function commandNodes(program: Command.Command.Any): CommandNode[] {
  return visibleCommandChildren(program).map((command) => ({
    names: [...commandNames(command)],
    subcommands: visibleCommandNames(command)
  }));
}

const words = (values: readonly string[]): string => values.join(" ");
const topLevelNames = (nodes: readonly CommandNode[]): string[] => nodes.flatMap((node) => node.names);

function bashCompletion(binary: string, nodes: readonly CommandNode[]): string {
  const dynamic = `${binary} __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null`;
  const cases = nodes
    .filter((node) => node.subcommands.length > 0)
    .map(
      (node) =>
        `    ${node.names.join("|")}) COMPREPLY=( $(compgen -W "${words(node.subcommands)}" -- "$cur") ); return ;;`
    )
    .join("\n");
  return [
    `# bash completion for ${binary}`,
    `_${binary}_completion() {`,
    "  local cur dynamic",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  dynamic="$(${dynamic})"`,
    '  if [[ -n "${dynamic}" ]]; then COMPREPLY=( $(compgen -W "${dynamic}" -- "$cur") ); return; fi',
    `  if [[ \${COMP_CWORD} -eq 1 ]]; then COMPREPLY=( $(compgen -W "${words(topLevelNames(nodes))}" -- "$cur") ); return; fi`,
    '  case "${COMP_WORDS[1]}" in',
    cases,
    "  esac",
    "}",
    `complete -F _${binary}_completion ${binary}`,
    ""
  ].join("\n");
}

function zshCompletion(binary: string, nodes: readonly CommandNode[]): string {
  const cases = nodes
    .filter((node) => node.subcommands.length > 0)
    .map(
      (node) =>
        `    ${node.names.join("|")}) _values '${node.names[0]} command' ${words(node.subcommands)} ;;`
    )
    .join("\n");
  return [
    `#compdef ${binary}`,
    `_${binary}() {`,
    "  local -a dynamic",
    `  dynamic=(\${(f)"$(${binary} __complete -- \${words[@]:1:$((CURRENT-1))} 2>/dev/null)"})`,
    '  if (( ${#dynamic} )); then compadd -- "${dynamic[@]}"; return; fi',
    `  if (( CURRENT == 2 )); then _values '${binary} command' ${words(topLevelNames(nodes))}; return; fi`,
    '  case "$words[2]" in',
    cases,
    "  esac",
    "}",
    `_${binary} "$@"`,
    ""
  ].join("\n");
}

function fishCompletion(binary: string, nodes: readonly CommandNode[]): string {
  const helper = `__${binary}_complete`;
  const lines = [
    `# fish completion for ${binary}`,
    `function ${helper}`,
    "    set -l tokens (commandline -opc) (commandline -ct)",
    `    ${binary} __complete -- $tokens[2..-1] 2>/dev/null`,
    "end",
    `complete -c ${binary} -f -a "(${helper})"`,
    `complete -c ${binary} -f -n "__fish_use_subcommand" -a "${words(topLevelNames(nodes))}"`
  ];
  for (const node of nodes) {
    if (node.subcommands.length > 0) {
      lines.push(
        `complete -c ${binary} -f -n "__fish_seen_subcommand_from ${words(node.names)}" -a "${words(node.subcommands)}"`
      );
    }
  }
  return [...lines, ""].join("\n");
}

export function completionScript(
  shell: CompletionShell,
  binary: string,
  program: Command.Command.Any
): string {
  const nodes = commandNodes(program);
  switch (shell) {
    case "bash":
      return bashCompletion(binary, nodes);
    case "zsh":
      return zshCompletion(binary, nodes);
    case "fish":
      return fishCompletion(binary, nodes);
  }
}
