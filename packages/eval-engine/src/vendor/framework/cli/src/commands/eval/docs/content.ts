// Reference material for `ori eval docs`. Keep this data close to the CLI so
// the guidance stays matched to the version of the installed command.

export interface EvalDocTopic {
  readonly topic: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

const markdown = (text: string): string =>
  text.replaceAll("\\`", "`").replaceAll("\\${", "${");

export const EVAL_DOC_TOPICS: readonly EvalDocTopic[] = [
  {
    topic: "sdk",
    title: "SDK and eval surface",
    summary: "The `ori/eval` API, run data, and code patterns.",
    body: markdown(String.raw`### Varying one thing

\`agent.run\` also takes an object: \`{ prompt, systemPrompt, model, env, parameters, outputSchema }\`. A per-case \`systemPrompt\` is what lets you measure a proposed prompt fix against the current one in a single file, instead of editing the repo and trusting your memory of the before. The run is data as well as matchers, carrying \`text\`, \`toolCalls\`, \`events\`, \`durationMs\`, and \`costUsd\`, so a check with no matcher is an ordinary \`assert\`. \`costUsd\` is \`undefined\`, never \`0\`, when the harness reported nothing.

## A minimal eval

\`\`\`ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupAgent } from "ori/eval";

const agent = setupAgent();

test("recommends restaurants using the search tool", async () => {
  const run = await agent.run("Where should I eat dinner in Lisbon?");

  run.tool("search").toBeCalled();
  run.tool("delete_file").toNotBeCalled();
  run.toComplete();
  assert.equal(typeof run.text, "string");
});
\`\`\`

\`setupAgent()\` binds the workspace's resolved harness and model.

## A dataset loop

\`\`\`ts
import supportPairs from "./support-pairs.json";

for (const { question, mustMention } of supportPairs) {
  test(\`answers: \${question}\`, async () => {
    const run = await agent.run(question);
    run.toMention(mustMention);
    run.toComplete();
  });
}
\`\`\`

## Reading the live prompt

\`\`\`ts
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./data/prompts/classify.py", import.meta.url),
  "utf8"
);
const match = source.match(/SYSTEM_PROMPT = """(.*?)"""/s);
if (match?.[1] === undefined) {
  throw new Error("could not find SYSTEM_PROMPT in data/prompts/classify.py");
}
\`\`\`

The copy costs an explicit refresh when the production prompt changes. The eval cannot see later edits in the user's repository, so do not report an old copy as current evidence. Throwing when the copied file is missing or its expected content is absent fails loudly instead of measuring the wrong text.

## Pinning a named model

\`\`\`ts
import { assertModelIsLive } from "ori/eval";

const MODEL = "~anthropic/claude-sonnet-latest";
await assertModelIsLive(MODEL);
\`\`\`

## Measuring a prompt fix

\`\`\`ts
for (const [label, systemPrompt] of [
  ["current", CURRENT_PROMPT],
  ["proposed", PROPOSED_PROMPT],
] as const) {
  test(\`states the 30-day window (\${label})\`, async () => {
    const run = await agent.run({ prompt: STALE_BAG_TICKET, systemPrompt });
    run.toMention("30 days");
  });
}
\`\`\``),
  },
  {
    topic: "catalog",
    title: "Catalog",
    summary: "Catalog queries, quality indexes, and candidate selection.",
    body: markdown(String.raw`### Catalog

\`candidateModels(query)\` returns slugs and \`rankedModels(query)\` returns full \`CatalogModel\` records. Query fields: \`limit\`, \`maxPromptPrice\`, \`maxCompletionPrice\`, \`minContextLength\`, \`minIntelligenceIndex\`, \`minCodingIndex\`, \`minAgenticIndex\`, \`requiredParameters\`, \`requiredInputModalities\`, \`excludeExpiring\`, \`include\`, \`exclude\`.

Every slug comes from the catalog, never from memory. The catalog turns over weekly, so a slug you recall may already be retired and names none of the ones released since, and a slug that is not a real model does not error: the run comes back empty and you hand over a green artifact that graded nothing. When the user names a model, pin it and assert it with \`assertModelIsLive\`. Moving \`-latest\` aliases are tilde-prefixed, so \`anthropic/claude-sonnet-latest\` is not a slug, and guessing that prefix is exactly what the assertion catches.

Translate capability rather than reaching for an index: tools to \`requiredParameters: ["tools"]\`, images to \`requiredInputModalities: ["image"]\`, huge documents to \`minContextLength\`, code to \`minCodingIndex\`, long agent loops to \`minAgenticIndex\`, and open weights or vendor bans to \`include\` and \`exclude\`, which match substrings on the slug.

The quality indices are sparse. \`minIntelligenceIndex\`, \`minCodingIndex\`, and \`minAgenticIndex\` come from Artificial Analysis, which scores about a third of the catalog, and an unscored model fails the bound silently, so \`minIntelligenceIndex: 40\` quietly discards models that would have been fine. Check the ratio rather than trusting a number in a doc, comparing \`(await rankedModels({})).filter((m) => m.intelligenceIndex !== undefined).length\` against the full count. Use an index floor only when the user wants "measured as smart", and use capability and price filters when they want a capability, because every model reports those. If a query comes back empty, drop the index floor first and say you did.

\`rankedModels\` filters in catalog order and has no sort parameter, so do not promise a ranking the API does not produce. Sort yourself on \`CatalogModel\` fields, and sort on \`completionPrice\` rather than \`promptPrice\` when the task is output-heavy, because a summarizer pays mostly on the way out. It returns a \`readonly\` array while \`candidateModels\` returns a mutable one, on purpose: iterate a copy if you need a mutable table.

A model comparison has exactly five candidate slugs from the catalog. Give each candidate its own \`test()\`. Five is the number of models. Do not use it as the number of cases. Get the number of cases from the data you have. Too few cases give an unstable winner, and more cases cost more money and take more time. When the workspace has an incumbent, include it as an additional pinned and asserted run because "is my current model still right" is usually the real question. Do not race candidates inside one \`test()\` behind \`Promise.all\`: a failing assertion throws, \`Promise.all\` rejects on the first, and every candidate still in flight is killed mid-run, so you paid for those calls and learned nothing. Use \`Promise.allSettled\` and assert after everything settles if you need concurrency inside one test. Report every candidate in fixed columns: \`model\`, \`outcome or pass rate\`, \`cost\`, \`latency\`, \`judge score\`. Recommend exactly one slug, explain what you weighted, and state what you could not measure. A fallback may appear as one sentence beneath it.

## A model comparison

\`\`\`ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateModels,
  setupAgent,
  setupJudge,
  startingCriteria,
} from "ori/eval";

const PROMPT = "A customer says their order arrived damaged. Reply to them.";

const candidates = await candidateModels({
  limit: 5,
  requiredParameters: ["tools"],
  maxPromptPrice: 0.000_003,
});

const judge = setupJudge({ minScore: 0.7 });

for (const model of candidates) {
  test(\`handles a damaged-order complaint: \${model}\`, async () => {
    const run = await setupAgent({ model }).run(PROMPT);

    run.toComplete();
    run.toFinishWithin(60_000);
    assert.equal(run.text.length > 0, true);

    await judge.autoEvals({
      criteria: [startingCriteria.accuracy, startingCriteria.toneAndVoice].join(
        "\n\n"
      ),
      prompt: PROMPT,
      run,
    });
  });
}
\`\`\``),
  },
  {
    topic: "providers",
    title: "Providers and routing",
    summary: "Endpoint spread, provider metadata, and routing variants.",
    body: markdown(String.raw`### Providers

A slug is not an endpoint. One \`deepseek\` slug was served by 21 endpoints spanning three quantizations, a 2.2x price spread, and uptimes from 0% to 99.99%, with routing moving between runs, so a comparison that ignores this compares endpoints as much as models. \`modelEndpoints(slug)\` shows the spread before you spend anything and \`endpointProviders(slug)\` gives distinct names.

Use \`tag\` when you tabulate, because it is the endpoint variant id and without it one provider appears twice with no way to tell the rows apart. Degraded endpoints stay in the list on purpose, since a model whose only endpoint is down should read as degraded rather than vanish, and an endpoint with no measured uptime has not been measured, which is not zero.

Routing is mandatory and runs only against the recommended slug. Evaluate the fixed variants \`bare\`, \`:nitro\`, \`:floor\`, and \`:exacto\`. Routing modifiers are part of the slug and pass through \`setupAgent({ model })\` like any candidate: bare takes the default, \`:nitro\` asks for throughput, \`:floor\` asks for price, and \`:exacto\` asks for Exacto provider sorting. Write the slugs out literally, because a model is typed \`ModelSlug\`, the literal \`\` \`\${string}/\${string}\` \`\` shape, and a template literal widens to \`string\` and fails \`tsc\`. \`ModelValue\` is that type unioned with \`null\`.

A modifier is a routing preference, not a price guarantee. In three independent runs, \`:floor\` was never the cheapest and was usually the most expensive, with bare averaging $0.0002 per run against \`:floor\` at $0.0016. That is not a token effect: \`:floor\` spent fewer tokens and still cost eight times as much, having landed on a pricier endpoint. Never tell a user that \`:floor\` is the cheap one from its name. Run the variants, read per-run cost, report what you measured.

Pinning one exact provider is not possible today, because that needs the \`provider.order\` request parameter and no harness plumbs it. A provider recommendation is therefore a recommendation of a modifier or of a different model, so say which you mean.

## Endpoint spread

\`\`\`ts
const endpoints = await modelEndpoints("deepseek/deepseek-v4-flash");
// provider, tag, quantization, promptPrice, completionPrice, cacheReadPrice,
// contextLength, maxCompletionTokens, supportedParameters, status,
// uptimeLast30m, uptimeLast1d
\`\`\``),
  },
  {
    topic: "judging",
    title: "Judging",
    summary: "Judge setup, criteria, and automatic evaluations.",
    body: markdown(String.raw`### Judging

\`setupJudge()\` defaults to \`~anthropic/claude-opus-latest\`. In measured comparisons of three cheap models over a small set of cases, the judge was 91 to 97 percent of total spend, with the models under test a rounding error. Judge cost is a reason to use a less expensive grader. It is not a reason to measure fewer cases, because the number of cases is what makes the result trustworthy. That default is right when the verdict is the product and wrong when you are iterating on the eval, so swap it with \`setupJudge({ agent: setupAgent({ model: "..." }) })\` and say which grader produced the scores.

Skip the judge entirely when the answer is exactly checkable, such as a classifier returning one of five labels or a formatter returning JSON, because a judge there is pure cost on a question that has a right answer. \`minScore\` defaults to \`0\`, so an ungated judge passes anything it marked \`pass: true\` however weak the score: set it deliberately.

\`judge.autoEvals\` books its verdict against the candidate it graded, so the comparison reads per model. \`judge.evaluate\` returns the same verdict but records nothing, so pair it with a real assertion or that run stays \`unknown\` forever; it also accepts a raw \`output\` string instead of a \`run\`, which grades a rubric with no agent call at all and is the cheap way to sanity-check criteria you just wrote.

Criteria compose, but check the seam. The six are \`accuracy\`, \`completeness\`, \`instructionFollowing\`, \`safety\`, \`structuredOutput\`, and \`toneAndVoice\`. Most end by deferring the other dimensions; two do not. \`instructionFollowing\` defers only accuracy, and \`safety\` defers nothing, ending on "pass only when handing this output to a real user would be safe", a whole-output judgement, so joining \`safety\` with another criterion gives you a grader that can fail a run on grounds the other meant to exclude. Check the rubric wants what your test wants: \`instructionFollowing\` on a case where the right answer is to refuse grades correct behavior as failure, confidently.`),
  },
  {
    topic: "results",
    title: "Results",
    summary: "Reading eval output: outcomes, scores, and costs.",
    body: markdown(String.raw`### Results

Human \`ori eval\` output prints blocks in order: one test line per \`test()\` with \`pass\`, \`FAIL\`, or \`skip\` and the test name, then one run line per candidate or judge with its resolved model and measurements, then the candidate and judge spend split when judge rows exist, and finally the baseline comparison when \`--baseline\` has one. Only the run block carries models, scores, context tokens, and costs. \`skip\` appears only on test lines. A run that has no resolved model falls back to its requested model, and otherwise prints \`unknown\`; an ungraded run omits \`score\` rather than printing \`score=0.00\`. Read the blocks in that order instead of treating every line as a model result.

Filter out judge lines before comparing candidates. Judge lines begin with \`judge\`, and the spend summary separately labels \`candidates\` and \`judge\`. Candidate lines do not need an explicit \`candidate\` label.

Use the outcome label and the indented detail line together. \`pass\` and \`FAIL\` are run outcomes, while \`outcome?\` means no asserted outcome. A failed run's detail follows its line. A \`CUT OFF\` run is not a measurement: keep its missing outcome, latency, and cost as gaps. The human report also prints candidate and judge spend splits, so do not combine judge spend into a candidate's cost.

Score separates candidates that both pass. Read \`score=<value>\` when it is present, and omit it from your own table when it is absent. Cost is formatted with six decimals and context appears as \`<n> tok\`; missing values are gaps or \`unmeasured\`, never zero. Do not write \`$0.00\` for an unreported cost, \`0%\` for a model with no asserted result, or a rank for a model with no measurement.

## Reading results

Read the plain output from \`ori eval\`. A single run produced:

\`\`\`text
pass  handles a damaged-order complaint: openai/gpt-4.1-mini 2150ms
pass  answers a refund question: openai/gpt-4.1-mini 2180ms
FAIL  handles a damaged-order complaint: anthropic/claude-3.7-sonnet 2780ms
FAIL  answers a refund question: google/gemini-2.5-flash 120000ms
skip  matches our published support tone
pass  openai/gpt-4.1-mini  2150ms  2 tools  320 chars  score=0.92  4096 tok  $0.001234
pass  openai/gpt-4.1-mini  2180ms  2 tools  290 chars  score=0.88  3968 tok  $0.001234
FAIL  anthropic/claude-3.7-sonnet  2780ms  1 tool  180 chars  score=0.41  3072 tok  $0.003456
  The answer omitted the required refund window.
judge  ~anthropic/claude-sonnet-4  820ms  2048 tok  $0.004321
outcome?  google/gemini-2.5-flash  CUT OFF
candidates  4 runs  (1 cut off)  $0.005924
judge       1 run  $0.004321
\`\`\`

Filter the \`judge\` run lines before comparing candidates. Keep failure details, \`score=<value>\`, \`CUT OFF\`, and the candidate versus judge spend lines in the report. If a value is not printed, leave that cell as \`unmeasured\`.`),
  },
  {
    topic: "running",
    title: "Running evals",
    summary: "Credential resolution, timeouts, history, reports, and commands.",
    body: markdown(String.raw`### Running

\`ori eval\` resolves its credential the same way \`ori code\` does: a key already in the environment first, then the workspace \`.ori/credentials.json\`, then the global \`~/.ori/credentials.json\` and \`~/.openrouter/credentials.json\`. Anyone who has run \`ori login\`, locally or globally, is already set up, and the resolved key is exported into the \`node --test\` child. The environment check counts the credential the CLI resolves from the launch directory at startup, so a launch-directory or global key wins over a different workspace's when you run \`ori eval <path>\` from elsewhere. A run with no credential anywhere fails before any model call and says to run \`ori login\`, and in json mode it fails rather than opening a login flow, so the single JSON document stays parseable.

A failing eval fails the shell and CI, and the process exits \`1\` rather than forwarding Node's exact code, but the printed failure names the real one as \`\` \`node --test\` exited with code N \`\`, so you never need a second run to learn it. The per-test timeout is 120s, and a long agent loop that exceeds it fails as a bare Node timeout with no eval-level explanation, so raise it with \`--timeout <ms>\` or per-\`test()\` with \`{ timeout }\`, which wins. Discovery skips \`node_modules\`, \`.git\`, and \`.ori\`, so an eval parked under \`.ori/\` silently never runs.

Runs inside an Ori workspace append to \`.ori/eval/history.jsonl\`, which is git-ignored and capped at 200 runs, and \`--no-history\` skips it. Scratch runs append to the history inside that scratch workspace, and their baseline series is local to that directory. \`--baseline last|best|model:<slug>\` is reporting only and never changes the exit code. \`--report <path>\` resolves against the eval directory rather than your cwd, so \`ori eval evals/support --report comparison.md\` writes \`evals/support/comparison.md\`, and a scratch run writes beside its eval. While iterating, re-run one file, not the whole comparison, because every full run spends real money.

## Commands

\`\`\`sh
ori eval                              # every *.eval.ts in the workspace
ori eval evals/support                # one directory or file
ori eval /tmp/tmp.AbC123              # a throwaway eval outside the workspace
ori eval --report comparison.md       # shareable markdown
ori eval --baseline best              # compare against the best earlier run
ori eval --timeout 300000             # raise the per-test ceiling from 120s
ori eval --list --allow-no-key        # list what would run, no key, no model call
\`\`\``),
  },
  {
    topic: "lifecycle",
    title: "Lifecycle and CI",
    summary: "How to develop evals and run them in CI.",
    body: markdown(String.raw`### Lifecycle

Write the eval before the behavior exists and watch it fail, because a failing first run proves the eval constrains the agent. Each time the agent misbehaves in real use, add the failing case, then fix the prompt. Keep the suite small, because every run spends money.

In CI, evals make real model calls, so put them in a credentialed, opt-in job with the key as a secret rather than the default unit-test job. An \`ori eval --list --allow-no-key\` step needs no key and cheaply asserts the evals still exist.`),
  },
];
