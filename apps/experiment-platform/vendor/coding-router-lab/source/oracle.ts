import { runCodexReadOnly } from "./codex-harness.ts";
import type { AreaCardV1, SilverLabelV1, TaskEpisode } from "./types.ts";

export const silverLabelJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selectedAreaIds", "known", "unknownType", "difficulty", "confidence", "reason", "relevantPaths"],
  properties: {
    selectedAreaIds: { type: "array", maxItems: 2, items: { type: "string" } },
    known: { type: "boolean" },
    unknownType: { anyOf: [{ type: "string", enum: ["new_repository_area", "outside_scope", "insufficient_information"] }, { type: "null" }] },
    difficulty: { type: "string", enum: ["clear", "contextual", "boundary_multi_area", "unknown", "insufficient_information"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reason: { type: "string" },
    relevantPaths: { type: "array", items: { type: "string" } },
  },
} as const;

const renderCards = (cards: AreaCardV1[]): string => cards.map((card) => JSON.stringify(card)).join("\n");

export const buildOraclePrompt = (episode: TaskEpisode, cards: AreaCardV1[]): string => `You are labeling a coding task for a repository-specific runtime router.

You receive the complete relevant visible task episode below and a frozen list of known Area Cards. You have read-only access to the repository at the pre-task snapshot.

The checkout is disposable. Never write, edit, install, build, test, access the
network, or invoke any command that mutates repository or external state. The
only allowed tool operations are local inspection commands such as pwd, ls,
find, git grep, rg, sed, cat, head, tail, and git show.

Determine whether the requested work belongs to zero, one, or two known areas. Do not infer from model reputation or routing evidence. Do not invent a known-area ID.

For every case that is not plainly outside repository scope or plainly
insufficient-information, you MUST use the read-only repository tools before
the final answer and inspect at least one existing repository path that
supports the classification. Do not emit a provisional JSON answer before
inspection. If repository tools fail or no supporting path can be verified,
return insufficient information rather than inventing evidence.

Return unknown when no known area is a valid match. Distinguish a genuinely new repository area from outside scope and insufficient information. If two areas are material, return both. Cite repository-relative paths. Keep the explanation short and factual. Set unknownType to null when known is true.

[TASK EPISODE]
${JSON.stringify(episode, null, 2)}

[AREA CARDS]
${renderCards(cards)}`;

export const runSilverOracle = async (input: { repository: string; episode: TaskEpisode; cards: AreaCardV1[]; model: string; passCount?: number; onTrace?: (trace: { pass: number; stdout: string; stderr: string; durationMs: number; finalMessage: string; toolCalls: number; usage: import("./codex-harness.ts").CodexRunResult["usage"] }) => Promise<void> }): Promise<SilverLabelV1[]> => {
  const allowed = new Set(input.cards.map((card) => card.areaId));
  const results: SilverLabelV1[] = [];
  const passes = input.passCount ?? 1;
  for (let pass = 0; pass < passes; pass += 1) {
    const result = await runCodexReadOnly({ repository: input.repository, snapshot: input.episode.repositorySnapshot, model: input.model, prompt: buildOraclePrompt(input.episode, input.cards), outputSchema: silverLabelJsonSchema });
    if (result.exitCode !== 0 || !result.finalMessage) {
      throw new Error(
        `Codex oracle failed (${result.exitCode}). stderr: ${result.stderr.slice(-4_000)} stdout: ${result.stdout.slice(-8_000)}`,
      );
    }
    await input.onTrace?.({ pass: pass + 1, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, finalMessage: result.finalMessage, toolCalls: result.toolCalls, usage: result.usage });
    const parsed = JSON.parse(result.finalMessage) as {
      selectedAreaIds: string[]; known: boolean; unknownType: SilverLabelV1["unknownType"] | null;
      difficulty: SilverLabelV1["difficulty"]; confidence: SilverLabelV1["confidence"]; reason: string; relevantPaths: string[];
    };
    if (new Set(parsed.selectedAreaIds).size !== parsed.selectedAreaIds.length) {
      throw new Error("Oracle repeated an area ID");
    }
    for (const id of parsed.selectedAreaIds) if (!allowed.has(id)) throw new Error(`Oracle invented area ID ${id}`);
    if (parsed.known !== (parsed.selectedAreaIds.length > 0)) throw new Error("Oracle known flag conflicts with selected areas");
    results.push({
      schemaVersion: 1, taskEpisodeId: input.episode.id, selectedAreaIds: parsed.selectedAreaIds, known: parsed.known,
      ...(!parsed.known && parsed.unknownType ? { unknownType: parsed.unknownType } : {}), difficulty: parsed.difficulty, confidence: parsed.confidence,
      reason: parsed.reason, relevantPaths: parsed.relevantPaths,
      oracle: { model: input.model, reasoningEffort: "high", passCount: passes, adjudicated: false, humanReviewed: false, toolCalls: result.toolCalls, repositoryInspected: result.toolCalls > 0 },
    });
  }
  return results;
};
