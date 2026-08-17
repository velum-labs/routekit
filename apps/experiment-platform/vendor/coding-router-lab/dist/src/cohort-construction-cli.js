import path from "node:path";
import { auditCohortSnapshotResolution, buildConversationalCodingCohort, buildDiversePublicCohort, buildNaturalHardCohort, } from "./cohort-construction.js";
const valueAfter = (args, flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
};
const args = process.argv.slice(2);
const command = args[0];
const labRoot = path.resolve(valueAfter(args, "--lab-root") ?? ".");
const privateRoot = path.join(labRoot, "data/private");
if (command === "conversational") {
    await buildConversationalCodingCohort({
        labRoot,
        outputDirectory: valueAfter(args, "--output-directory") ??
            path.join(privateRoot, "real-conversational-coding-v1"),
    });
}
else if (command === "public-diverse") {
    await buildDiversePublicCohort({
        outputDirectory: valueAfter(args, "--output-directory") ??
            path.join(privateRoot, "public-issue-diverse-v1"),
    });
}
else if (command === "hard") {
    await buildNaturalHardCohort({
        publicCohortDirectory: valueAfter(args, "--public-cohort-directory") ??
            path.join(privateRoot, "public-issue-diverse-v1"),
        outputDirectory: valueAfter(args, "--output-directory") ??
            path.join(privateRoot, "natural-hard-cohort-v1"),
    });
}
else if (command === "snapshot-audit") {
    const repositoryPaths = {
        "kubernetes/kubernetes": valueAfter(args, "--kubernetes-repository") ??
            "/home/benjamin/repos/kubernetes-public-benchmark",
        "grafana/grafana": valueAfter(args, "--grafana-repository") ??
            "/home/benjamin/repos/grafana-public-benchmark",
    };
    await auditCohortSnapshotResolution({
        cohortDirectory: path.join(privateRoot, "public-issue-diverse-v1"),
        repositoryPaths,
    });
    await auditCohortSnapshotResolution({
        cohortDirectory: path.join(privateRoot, "natural-hard-cohort-v1"),
        repositoryPaths,
    });
}
else if (command === "all") {
    const conversational = path.join(privateRoot, "real-conversational-coding-v1");
    const publicDiverse = path.join(privateRoot, "public-issue-diverse-v1");
    const hard = path.join(privateRoot, "natural-hard-cohort-v1");
    await buildConversationalCodingCohort({
        labRoot,
        outputDirectory: conversational,
    });
    await buildDiversePublicCohort({ outputDirectory: publicDiverse });
    await buildNaturalHardCohort({
        publicCohortDirectory: publicDiverse,
        outputDirectory: hard,
    });
}
else {
    throw new Error("Usage: cohort-construction-cli <conversational|public-diverse|hard|snapshot-audit|all> [--lab-root DIR] [--output-directory DIR]");
}
