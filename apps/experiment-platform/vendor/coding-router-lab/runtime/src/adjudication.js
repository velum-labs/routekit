const signature = (label) => JSON.stringify({ selectedAreaIds: [...label.selectedAreaIds].sort(), known: label.known, unknownType: label.unknownType ?? null });
export const adjudicateSilverLabels = (passes) => {
    const groups = new Map();
    for (const label of passes)
        groups.set(label.taskEpisodeId, [...(groups.get(label.taskEpisodeId) ?? []), label]);
    const adjudicated = [], unresolved = [];
    for (const [taskEpisodeId, labels] of groups) {
        const counts = new Map();
        for (const label of labels)
            counts.set(signature(label), (counts.get(signature(label)) ?? 0) + 1);
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const winner = ranked[0];
        const strictMajority = winner && winner[1] > labels.length / 2;
        if (!winner || !strictMajority) {
            unresolved.push({
                taskEpisodeId, passCount: labels.length,
                signatures: ranked.map(([value, count]) => ({ signature: value, count })),
                reasons: labels.map((label) => label.reason),
            });
            continue;
        }
        const chosen = labels.find((label) => signature(label) === winner[0]);
        adjudicated.push({
            ...chosen,
            oracle: { ...chosen.oracle, passCount: labels.length, adjudicated: true },
            reason: labels.filter((label) => signature(label) === winner[0]).map((label) => label.reason).sort((a, b) => a.length - b.length)[0] ?? chosen.reason,
            relevantPaths: [...new Set(labels.filter((label) => signature(label) === winner[0]).flatMap((label) => label.relevantPaths))].sort(),
        });
    }
    return {
        adjudicated, unresolved,
        summary: { tasks: groups.size, agreed: adjudicated.length, unresolved: unresolved.length, agreementRate: adjudicated.length / Math.max(1, groups.size) },
    };
};
