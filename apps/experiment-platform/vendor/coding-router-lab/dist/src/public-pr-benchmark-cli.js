import { collectBackstagePublicPrBenchmark } from "./public-pr-benchmark.js";
const valueAfter = (args, flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
};
const integerAfter = (args, flag) => {
    const raw = valueAfter(args, flag);
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${flag} must be a positive integer`);
    }
    return value;
};
const args = process.argv.slice(2);
const outputDirectory = valueAfter(args, "--output-directory");
if (!outputDirectory) {
    throw new Error("Usage: public-pr-benchmark-cli --output-directory DIR");
}
const perKnownArea = integerAfter(args, "--per-known-area");
const naturalUnknowns = integerAfter(args, "--natural-unknowns");
const candidateLimitPerLabel = integerAfter(args, "--candidate-limit-per-label");
const issueGroundedOnly = args.includes("--issue-grounded-only");
await collectBackstagePublicPrBenchmark({
    outputDirectory,
    ...(perKnownArea === undefined ? {} : { perKnownArea }),
    ...(naturalUnknowns === undefined ? {} : { naturalUnknowns }),
    ...(candidateLimitPerLabel === undefined
        ? {}
        : { candidateLimitPerLabel }),
    ...(issueGroundedOnly ? { issueGroundedOnly: true } : {}),
});
