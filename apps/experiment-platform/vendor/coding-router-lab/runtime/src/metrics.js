const setEqual = (a, b) => a.length === b.length && a.every((value) => b.includes(value));
export const topTwoAreaIds = (prediction) => {
    const ranked = prediction.areaScores
        .slice(0, 2)
        .map((score) => score.areaId);
    return ranked.length > 0
        ? ranked
        : prediction.selectedAreaIds.slice(0, 2);
};
export const calculateMetrics = (labels, predictions) => {
    const byId = new Map(predictions.map((item) => [item.taskEpisodeId, item]));
    let correctTopTwo = 0, silverAreaCount = 0, exact = 0, exactSemantic = 0, knownUnknownCorrect = 0, singleAreaCorrect = 0, singleAreaCount = 0, falseKnown = 0, unknownCount = 0, falseUnknown = 0, knownCount = 0;
    for (const label of labels) {
        const prediction = byId.get(label.taskEpisodeId);
        if (!prediction)
            throw new Error(`Missing prediction for ${label.taskEpisodeId}`);
        const routingExact = setEqual(label.selectedAreaIds, prediction.selectedAreaIds) &&
            label.known === prediction.known;
        if (routingExact)
            exact += 1;
        if (label.known === prediction.known)
            knownUnknownCorrect += 1;
        if (routingExact &&
            (label.known || label.unknownType === prediction.unknownType)) {
            exactSemantic += 1;
        }
        if (label.known) {
            knownCount += 1;
            const topTwo = topTwoAreaIds(prediction);
            silverAreaCount += label.selectedAreaIds.length;
            correctTopTwo += label.selectedAreaIds.filter((id) => topTwo.includes(id)).length;
            if (!prediction.known)
                falseUnknown += 1;
            if (label.selectedAreaIds.length === 1) {
                singleAreaCount += 1;
                if (topTwo[0] === label.selectedAreaIds[0])
                    singleAreaCorrect += 1;
            }
        }
        else {
            unknownCount += 1;
            if (prediction.known)
                falseKnown += 1;
        }
    }
    const count = labels.length;
    return {
        count,
        topTwoRecall: silverAreaCount ? correctTopTwo / silverAreaCount : 0,
        exactLabelSetMatch: count ? exact / count : 0,
        exactSemanticDecision: count ? exactSemantic / count : 0,
        knownUnknownAccuracy: count ? knownUnknownCorrect / count : 0,
        topOneSingleAreaAccuracy: singleAreaCount ? singleAreaCorrect / singleAreaCount : null,
        falseKnownRate: unknownCount ? falseKnown / unknownCount : null,
        falseUnknownRate: knownCount ? falseUnknown / knownCount : null,
        raw: { correctTopTwo, silverAreaCount, exact, exactSemantic, knownUnknownCorrect, singleAreaCorrect, singleAreaCount, falseKnown, unknownCount, falseUnknown, knownCount },
    };
};
