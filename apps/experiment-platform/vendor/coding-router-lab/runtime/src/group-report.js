import { calculateExtendedMetrics } from "./experiment-metrics.js";
const userHash = (episode) => episode.schemaVersion === 2 ? episode.provenance.userIdHash : "legacy-or-unspecified";
export const buildGroupedReport = (episodes, labels, predictions) => {
    const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
    const labelById = new Map(labels.map((label) => [label.taskEpisodeId, label]));
    const predictionById = new Map(predictions.map((prediction) => [prediction.taskEpisodeId, prediction]));
    const groups = new Map();
    for (const label of labels) {
        const episode = episodeById.get(label.taskEpisodeId);
        if (!episode)
            throw new Error(`Missing episode for grouped label ${label.taskEpisodeId}`);
        const key = `${userHash(episode)}\0${episode.repositoryId}`;
        groups.set(key, [...(groups.get(key) ?? []), episode.id]);
    }
    const groupReports = [...groups.entries()].map(([key, ids]) => {
        const [idHash, repositoryId] = key.split("\0");
        const groupLabels = ids.map((id) => labelById.get(id));
        const groupPredictions = ids.map((id) => {
            const prediction = predictionById.get(id);
            if (!prediction)
                throw new Error(`Missing grouped prediction ${id}`);
            return prediction;
        });
        return { userIdHash: idHash, repositoryId: repositoryId, cases: ids.length, metrics: calculateExtendedMetrics(groupLabels, groupPredictions) };
    }).sort((a, b) => a.userIdHash.localeCompare(b.userIdHash) || a.repositoryId.localeCompare(b.repositoryId));
    const warnings = [];
    if (groupReports.length < 2)
        warnings.push("Only one user/repository group is present; Experiment 6 confirmation is incomplete.");
    if (groupReports.some((group) => group.cases < 20))
        warnings.push("At least one group has fewer than 20 cases; group comparisons are unstable.");
    return { schemaVersion: 1, groups: groupReports, pooled: calculateExtendedMetrics(labels, predictions), warnings };
};
