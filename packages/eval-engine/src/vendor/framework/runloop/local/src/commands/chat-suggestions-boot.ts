import type { ChatSuggestion } from "../../../../contracts/author/src/chat.ts";
import type { CommandRegistryShape } from "../../../../engine/registries/src/capability.ts";
import type { SkillRegistryShape } from "../../../../engine/registries/src/skill.ts";

/**
 * Build the {@link ChatSuggestion} rows from a boot's command and skill
 * registries, ready to inject onto `Chat.suggestions`. Commands come first;
 * a skill whose name collides with a command is dropped (the command's slash
 * dispatch wins, so a duplicate row would mislead). Returns undefined when the
 * workspace registers neither, so lightweight surfaces see the field unset.
 */
export const makeChatSuggestionsFromBoot = (input: {
  readonly builtInCodeSkillSuggestions?: readonly ChatSuggestion[];
  readonly commandRegistry: CommandRegistryShape;
  readonly skillRegistry: SkillRegistryShape;
}): readonly ChatSuggestion[] | undefined => {
  const commands = input.commandRegistry.entries.map((entry) => ({
    description: entry.value.description,
    name: entry.name,
  }));
  const suggestions: ChatSuggestion[] = [...commands];
  const builtInCodeSkills = input.builtInCodeSkillSuggestions ?? [];
  const canonicalNames = new Set([
    ...commands.map((command) => command.name),
    ...input.skillRegistry.entries.map((entry) => entry.name),
    ...builtInCodeSkills.map((suggestion) => suggestion.name),
  ]);
  const seenCanonicalNames = new Set(commands.map((command) => command.name));
  const claimedAliases = new Set<string>();
  for (const entry of input.skillRegistry.entries) {
    if (seenCanonicalNames.has(entry.name)) {
      continue;
    }
    const aliases = (entry.commandAliases ?? []).filter(
      (alias) => !canonicalNames.has(alias) && !claimedAliases.has(alias)
    );
    for (const alias of aliases) {
      claimedAliases.add(alias);
    }
    seenCanonicalNames.add(entry.name);
    suggestions.push({
      ...(aliases.length > 0 ? { aliases } : {}),
      description: entry.description,
      name: entry.name,
    });
  }
  for (const suggestion of builtInCodeSkills) {
    if (seenCanonicalNames.has(suggestion.name)) {
      continue;
    }
    const aliases = (suggestion.aliases ?? []).filter(
      (alias) => !canonicalNames.has(alias) && !claimedAliases.has(alias)
    );
    for (const alias of aliases) {
      claimedAliases.add(alias);
    }
    seenCanonicalNames.add(suggestion.name);
    suggestions.push({
      ...(aliases.length > 0 ? { aliases } : {}),
      description: suggestion.description,
      name: suggestion.name,
    });
  }
  return suggestions.length === 0 ? undefined : suggestions;
};
