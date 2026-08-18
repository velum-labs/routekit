---
name: create-eval
description: Write an agent eval as a node:test with ori/eval, then run it with ori eval. TRIGGER when the user asks to test, eval, or measure whether their agent does the right thing, to catch regressions in agent behavior, or to compare models and pick the best one for their task ("which model is best", "is this model good enough", "run a model comparison test", "does my agent still work"), including bare model-selection requests such as "find the best model", "pick the best model", "choose the best model", "what model should I use", "best model for my app", "help me pick a model", "which model is best for my support bot or task", or "compare models". Also TRIGGER when the user asks which provider or routing to use for a model ("which provider should I use", "compare providers for this model", "is this model being served by different providers"), when the user asks which model to use as a primary and which as a fallback, or asks why their agent gave a bad answer and how to fix the prompt. Do NOT trigger for running an eval that already exists, for plain unit tests with no agent or model (use writing-tests), or for the model-free harness contract check (ori harness test).
metadata:
  command-aliases:
    - eval
---

# Create Eval

An eval checks that the real agent and model do the right thing on a real prompt: it called the tool it should have, skipped the one it should not, and gave a good answer. It reads like a normal node:test. You import from `ori/eval`, write a `*.eval.ts` file, and run it with `ori eval`, which discovers the files and runs them.

The eval tests the agent, not the codebase. The repo is just the workspace the agent acts on.

Assume the user knows nothing about evals or model selection, because most people writing their first one do not. They describe the goal; you choose the parameters, find the inputs, and write a file they can run. Do not make them supply a dataset format or name a model first.

An eval that reports a confident wrong number is worse than no eval, because they will act on it. The steps say what to do. The rules say how each step goes wrong. Read both.

## Steps

Work through these steps in order. They form five phases and have five user questions at minimum, six at most. The two conditional questions are mutually exclusive: `[surface]` applies when the collection finds more than one call site, while `[workspace-files]` applies only when the collection found no model call site and no material to mine.

1. Resolve the tracker directory. When the task prompt names a caller-owned run directory, use that exact directory, which must be outside the user's repository. When no caller-owned run directory is named, derive a tracker directory outside the user's repository from a stable hash of the evaluated workspace's absolute path, such as `/tmp/ori-create-eval-<workspace-hash>`. Keep the tracker and every file you write outside the scratch workspace together in whichever directory ends up holding this run's `steps.txt`. The scratch workspace is created elsewhere, so record its reported path beside the tracker. Use only the path reported when the scratch workspace is created.
2. Search the tracker directory and its timestamped subdirectories for `steps.txt`. Record the current request with whitespace collapsed before comparing it with a tracker.
3. Adopt the most recent tracker whose recorded request matches the current normalized request. A root `steps.txt` with no recorded request does not match and remains untouched. Reread the adopted tracker and read its `collection.md` immediately when it exists, before deciding what to do next. Continue at the first step not marked complete.
4. When no such tracker exists, start a fresh tracker. Write a fresh `steps.txt` at the tracker directory root only when the root holds no `steps.txt` at all. If the root holds any other tracker, including one with no recorded request or one for a different request, leave it untouched and write the fresh tracker in a timestamped subdirectory inside the same tracker directory. That subdirectory then holds the rest of this run's files. Record the current request on its first line and add one status line for every step in this list, using the same numbers, including the setup steps. Mark steps 1 to 4 complete when the tracker is created, and leave step 5 open until you have told the user where the tracker file is.
5. Tell the user where the adopted or newly created tracker file is.

6. Read the eval reference.
7. Announce phase 1 with `Phase 1/5: Workspace context`.
8. Collect the workspace once. Write `collection.md` beside `steps.txt`, put copied prompts under `material/prompts/`, datasets under `material/datasets/`, and gold answers under `material/gold/`. The record must contain the surface inventory with the model each site runs today, the incumbent slug, prompt sources with their paths and copy dates, tool names, dataset and gold-answer files with case counts, existing tests that encode behavior, and an explicit `found nothing` note for every requested category with no result. Present the inventory as a table (Appendix L). Mark this step complete only after the record and copies exist.
9. If the collection found more than one model call site, end the turn with one `[surface]` question listing the call sites found, up to three. If it found only two, use the third option for stopping rather than inventing a surface. Append the chosen surface to `collection.md` in the turn that receives the answer.
10. If the collection found no model call site and no material to mine, end the turn with one `[workspace-files]` question about files, tests, and related material. If the answer names new material, update `collection.md` and the relevant `material/prompts/`, `material/datasets/`, or `material/gold/` copy in the turn that receives it.
11. End the turn with one `[workspace-data]` question about real traffic to measure (Appendix M). Append the data decision to `collection.md` in the turn that receives the answer.
12. Announce phase 2 with `Phase 2/5: Criteria and narrowing`.
13. State the criteria derived from the user's prompt, reading the collection record rather than scanning the workspace.
14. End the turn with one `[criteria-priority]` question. Append the priority to `collection.md` in the turn that receives the answer.
15. End the turn with one `[evaluation-constraint]` question. Append the constraint to `collection.md` in the turn that receives the answer.
16. Announce phase 3 with `Phase 3/5: Model comparison`.
17. Translate the user's goals into named assertions, using the collection record and its recorded answers.
18. Choose the eval path. When the caller gives an exact `.routekit/evals/...`
    path and matching `.routekit/routing/...` path, use them unchanged. Otherwise
    use `ori eval scratch` for a throwaway measurement or
    `evals/<feature>/<name>.eval.ts` when the user wants it committed and
    re-runnable.
19. For a scratch eval, copy the collected prompt from `material/prompts/` into the scratch workspace. For a committed eval, reference the prompt at the source path already recorded in `collection.md`, resolved as a path relative to the eval file. Do not search the workspace for either prompt. Make the eval fail loudly if required prompt material is missing or malformed (`ori eval docs sdk --human`). For a scratch eval, keep the original source path and copy date in the eval or report.
20. Choose the cases from the data (see the Cases rule), using the collected copies and recorded data decision. Record how many and how you chose them.
21. Write the eval file (`ori eval docs sdk --human`).
22. Select exactly five candidate slugs from the catalog (`ori eval docs catalog --human`),
    unless the host task or user explicitly supplies a concrete slate. Preserve
    an explicit slate unchanged when it contains at least two models.
23. When the collection record has an incumbent, add it to the eval as an additional pinned and asserted candidate (`ori eval docs sdk --human`).
24. Give each candidate its own `test()` (`ori eval docs catalog --human`).
    Keep the suite self-contained: copy bounded source excerpts and case data
    beside the eval instead of importing files outside its directory.
25. Choose a judge deliberately, or skip it when the answer is exactly checkable.
26. Check the endpoint spread of any slug intended for recommendation (`ori eval docs providers --human`).
27. Pre-run the catalog metadata lookups with `candidateModels`, `rankedModels`, and `modelEndpoints`, then present the five candidates in a table with slug, prompt price per million tokens, completion price per million tokens, context length, quality index where scored, and the incumbent marked when present. These are metadata lookups, not model calls, and should not spend model money.
28. In the same turn, give the number of cases, how many the user supplied, how you chose them, the cost you expect, and the time you expect. The user can then ask for more cases or fewer before the run starts.
29. Before asking for approval, write `routekit.eval-manifest.json` beside the
    eval with `{ "version": 1, "candidateModels": [...], "judgeModel": "...",
    "caseCount": N, "maxOutputTokens": N }` for the proposed run. Import the
    manifest from the eval and assert that its case/model counts match the
    executable suite so it is part of the portable artifact closure. Then end
    the turn with one `[candidates]` question asking whether to launch with this
    slate and case set, swap a candidate, or stop. Append the approved slate and
    case count to `collection.md` in the turn that receives the answer.
30. If the user swaps a candidate, revise the slate, re-run the free metadata lookups for any new slug, re-check endpoint spread for any newly swapped-in slug intended for recommendation, present the table again, and ask `[candidates]` again. Do not launch anything that spends model money until the user approves the slate. Update the approved slate and case count in `collection.md` when the user answers.
31. Update the manifest if the approved slate differs from the proposal, then
    run the eval with the approved candidates plus the incumbent when one
    exists (`ori eval docs running --human`).
32. Read the results, filtering judge rows and rendering gaps as gaps (`ori eval docs results --human`, Appendix I).
33. Report the fixed result table with the model, outcome or pass rate, cost, latency, and judge score, and give the number of cases and how you chose them.
34. Diagnose each failure as prompt or model, and measure the fix rather than asserting it (`ori eval docs sdk --human`).
35. Recommend exactly one slug, explain what you weighted, give the number of cases and what you could not measure, and allow one fallback sentence beneath it.
36. Announce phase 4 with `Phase 4/5: Routing`.
37. Evaluate only the recommended slug with the fixed `bare`, `:nitro`, `:floor`, and `:exacto` variants (`ori eval docs providers --human`).
38. Report provider and routing findings.
39. Announce phase 5 with `Phase 5/5: Close`.
40. Report failures and session timing and cost before the final next-step question (see the Failures and Session report rules above and Appendix K).
41. End the turn with one `[next-step]` question in the answer text with three fixed options plus Other to close the run.

## Rules

Mark one step in this list current before doing it and complete before starting the next. Reread the tracker to decide what to do next instead of trusting memory. Never overwrite an existing tracker.

### Collection record

Phase 1 collects the workspace once. After step 8 is complete and `collection.md` exists beside `steps.txt`, every later step reads that record and its `material/` copies, or uses source paths already recorded there, instead of scanning the workspace again. This prevents a fresh `ori code` process for each question from paying for the same scan: step numbers survive in the tracker, but findings do not.

Re-reading the workspace is allowed only when the collection record says a specific thing was not found and the user has just named new material. In that case, update `collection.md` in the same turn with what was added and why, copy any needed material under the relevant `material/prompts/`, `material/datasets/`, or `material/gold/` directory, and use the updated record from then on.

### One question per turn

Ask one question, in one turn, then end the turn and wait. Never ask a compound question, put two tags in one turn, list a second question after the first, or append a follow-up question to an answer. If two answers are needed, ask for the first, wait for it, then ask for the second in the next turn. A bundled question gets one answer covering part of it, the rest is silently invented, and the eval then measures the wrong thing while looking answered.

### Reference

Run `ori eval --help` and `ori eval docs --human`, then read the relevant topics (`ori eval docs sdk --human`, `ori eval docs catalog --human`, `ori eval docs providers --human`, `ori eval docs judging --human`, `ori eval docs results --human`, `ori eval docs running --human`, and `ori eval docs lifecycle --human`) before writing the file. Pipes default to JSON, so use `--human` when you need to read or capture the markdown text. The CLI reference is compiled into the installed binary, so it matches the surface you will run. This skill covers workflow and judgement, while the CLI reference covers the API surface and wins when they disagree.

### Narration

A run is minutes of repo scanning and then minutes of model calls, and the user sees only your words, so silence reads as a hang. Before each slow phase, say what you are about to do and roughly how long it takes, in product terms ("reading your support-ticket code") rather than tool terms ("running grep"). Say so when something changes the plan.

> Running the model comparison: 24 cases across 5 candidates, judged after each. The slow part, usually 5 to 10 minutes.

### Run contract

Start each phase with one banner whose exact shape is `Phase N/5: <phase name>`. At a stopping point, put one question and its options in the answer text as the last thing in the turn, then end the turn and wait. Every stopping-point question begins with its literal bracketed tag. A headless run has no interactive surface, so an interactive question request comes back cancelled and the agent can end up grading its own guess. Never use an interactive question request for a stopping point, answer one yourself, or continue past it on an assumed answer. Every question has exactly three concrete options in the order you would pick them, plus a fourth free-text `Other` option. The options are workspace-specific guesses, not a claim that the right answer is among them. When fewer than three sensible options exist, include the default and the option to stop, then use the remaining option for the least-assumptive useful path rather than padding with nonsense.

### Surface

A codebase often calls models in several places, and an eval targets one, so guessing wrong makes every later assertion wrong. Present the inventory as a table, never prose, with two mandatory columns: the surface in plain product terms, and the model it runs today. The model column proves you found the real call site instead of guessing; write `unknown — set at runtime` when it comes from an env var you cannot read. Add columns the repo makes useful and skip ones that would be guesses. Ask for the surface only when the collection finds more than one model call site. If the directory is empty, say that no workspace or surface was found, use the user's prompt as the eval target, and do not invent a surface.

### Stopping points

Ask each question alone. Give exactly three options and a free-text `Other`. Then end the turn and wait. Do not answer the question yourself, do not go on with an assumed answer, and do not replace the question with an open offer.

- **`[surface]`** Ask this only when the collection finds more than one call site. List the call sites you found, up to three. If you found only two, make the third option "stop". Do not invent a call site.
- **`[workspace-files]`** Ask this only when you find no call site and no material to read. Ask which files, tests, or related material are available, and give three ways to go on.
- These two questions are exclusive. Ask one of them, never both.
- **`[workspace-data]`** Always ask for real traffic. Give three sources from the collection record, and make it easy to say no. If the user says no, write the cases yourself and tell the user that you wrote them.
- **`[criteria-priority]`** Ask which measure of success is the most important.
- **`[evaluation-constraint]`** Ask which practical limit the eval must hold.
- **`[candidates]`** First do the free catalog lookups. Show the candidate table: slug, prompt price per million tokens, completion price per million tokens, context length, quality index where there is one, and a mark on the incumbent. Then give the number of cases, how you chose them, the cost you expect, the time you expect, and the trade-off between more cases and fewer. Then ask: launch with these five slugs and the incumbent, swap a candidate, or stop. The user approves the case set here, so a user who wants more cases can say so in `Other`. Nothing that spends model money starts before the user answers.
- **`[next-step]`** Ask this last, in the answer text of the closing turn, and offer a concrete next step. The three options are: pin the winner, add the eval to CI, or do nothing more. More evaluation belongs in `Other`.

### Data

Invented prompts measure the agent against your imagination, so read `collection.md` first: its prompt findings give you the behavior to pin, its recorded tool names tell you which `tool(name)` assertions matter, its existing-test findings encode expected behavior, its copied data files are ready-made datasets for parameterized cases, and any copied file pairing an input with an approved output is what a judge grades against.

An eval is always a TypeScript `*.eval.ts` file whatever language the repo is written in. In a Python, Go, or Rust repo, do not write evals as pytest tests or Go tests: `ori eval` only discovers `*.eval.ts`, so anything else silently never runs. Nobody needs to install TypeScript, because `ori eval` runs the files through Node.

Ask for the real thing in `[workspace-data]` and make it easy to decline: ten real prompts beat a hundred you make up, and a path, an export, or ten pasted lines all work. When there is nothing, do not stall and do not quietly invent a dataset and present its score as a measurement. Write cases from what the collection record does say, in the number the Cases rule gives, tell the user in your reply and not only in a comment that you wrote them, say where each case came from, and prefer checkable behavior over graded quality.

### Cases

This skill gives you no number of cases. Get it from the data.

Five is the number of models. Do not use it as the number of cases.

Too few cases give an unstable result. One answer decides the winner, and the next run can change it.

- **The user gives data.** Use all of the collected data if `[evaluation-constraint]` allows this. If not, use 20 cases or more. Take them from all the categories, languages, and levels of difficulty. Do not use only the hardest cases, because all the models fail those.
- **The user gives no data.** Write 10 to 15 cases from the collected prompt, tools, and tests. Write one case for each rule you can check. Tell the user that you wrote them, and that they show less than real traffic.
- **More cases.** A more reliable winner. More money, and a longer run: each case is one call to each model, and one more call to the judge.
- **Fewer cases.** Less money, and a shorter run. The winner can be wrong.
- **Cost.** The judge is usually the largest part of the cost. Use a cheaper judge before you use fewer cases.
- **Say the number.** Give the number of cases, the cost, and the time when you ask `[candidates]`, and again in the report. Give the trade-off above too, so the user can ask for more cases or fewer. Example: "24 cases from your 893, from 8 categories and 2 languages. About $4, about 12 minutes." Below 20 cases, say the sample is small. If two models are one case apart, say the eval cannot separate them.

### Assertions

Users say "speed matters", not `maxCompletionPrice`, so translate:

- "get the facts right" to a judge with `startingCriteria.accuracy`
- "actually do the thing" to `run.tool("search").toBeCalled()`, `.toBeCalledWith({...})`, `run.toComplete()`
- "never do X" to `run.tool("delete_file").toNotBeCalled()`
- "follow my format" to `startingCriteria.structuredOutput`
- "sound like us" to `startingCriteria.toneAndVoice`
- "cannot be slow" to `run.toFinishWithin(30_000)`
- "cannot be expensive" to `run.toCostAtMost(0.01)` plus a price ceiling on selection
- "which model?" to a model comparison and a recommendation

State the criteria you derived from the user's prompt before asking the separate priority and constraint questions. Ask only what changes the eval. If the user is unsure, pick a default, say what you picked. When goals conflict, such as cheapest and smartest, never resolve it silently inside the file.

### Gold strings

`run.toMention` is a literal substring check. That is right for something the answer must reproduce exactly, such as an order id or a label a parser consumes, and wrong for prose. A `mustMention` dataset fails correct answers on typography (`3–5` against a gold `3-5`), on synonyms ("we'll send a replacement" against "reship"), and on stems ("deleting your account" against "delete"), and each one reads as a model failure without being one.

In order of preference: assert the exactly-checkable thing when the code under test parses the output, because `assert.equal(run.text.trim(), ...)` is the real contract; grade meaning with a judge when the claim is semantic, such as "states the 30-day policy"; or normalise before matching, folding dashes and case, and say you did, because a normalised match is a weaker claim. Before reporting any failure, read the actual answer, since a gold-string miss and a real policy error look identical in a pass or fail column and are opposite findings.

### File placement

Every import must be a package name or a path relative to the eval file, never an absolute path, a Windows drive path, a `file://` URL, or a path through `node_modules`, and `ori eval` rejects those before running anything. An eval exists to be committed and re-run, so an absolute path makes it worthless to everyone but you.

A throwaway eval goes in the self-contained workspace created by `ori eval scratch`, not the repo. When the user asked a question rather than for a test, the eval is a measuring instrument, not an artifact they asked to keep. Run it by the reported absolute path, report the numbers, and say where the workspace is so the user can move it into the repo later if they choose. The scratch command creates the manifest, SDK entries, starter template, and `data/` directory. Scratch runs keep their own `.ori/eval/history.jsonl`, so `--baseline last`, `--baseline best`, and `--baseline model:<slug>` compare runs made in that same scratch directory. The history and baseline series disappear when the scratch directory is removed. `--report` resolves against the eval directory, so the markdown lands beside the eval. The portability guard still applies, so a scratch eval cannot import the user's code. Copy anything it needs into the workspace instead.

### Prompts

For a scratch eval, copy a collected prompt from `material/prompts/` into the scratch workspace before writing the eval. For a committed eval, use the prompt at the source path already recorded in `collection.md`, resolved relative to the eval file. Do not search the workspace for a prompt. For a scratch eval, keep the original source path and copy date in the eval or its report. In either case, the eval reads the prompt at import and throws if it is missing or malformed:

Separate "does the prompt reach the model" from "which model is better". If the agent must find its own way to a skill, an early failure may mean the policy never arrived, and you will rank models on a policy none of them saw. Test delivery once using a fact that appears only in that prompt, such as a company name or an internal code, because a model can guess a plausible "30 days" from priors and hand you a false pass.

### Recommending

If they asked "which model should I use", answer it rather than handing back a table and stopping. There is no formula: a 911 call centre weights latency, a bulk classifier weights cost, a research agent weights task fitness. Only you heard what this user is building, so you pick the weighting and then say what you picked, so a reader can disagree with the weighting rather than only the answer. Pass or fail rarely separates the top two, so rank on the judge's `score` and say you did.

Name three things: the primary and the one property that won it, the fallback and what would make you switch, and what you weighted and what you could not measure. Give the number of cases too. A recommendation is only as strong as the number of cases behind it. If runs came from different providers, name the routing, because the same slug at fp4 on one provider is not the same product as fp8 on another and a recommendation that ignores which you measured cannot be reproduced.

### Failures

The most valuable output is usually not the score, it is learning the prompt was the problem. When a judge fails a case, its reason is the raw material: read the indented detail line beneath the failing run line, or from `--report`, which quotes every rejected run under `## Failures`. When every candidate fails the same case the same way, suspect the prompt; when one model fails what others pass, that is a model difference. Say which you are looking at, propose the concrete edit, and measure it rather than asserting it.

### Session report

Before the final `next-step` question, report a breakdown table of this session, because the user must see where their tokens and time went rather than guess. Give one row for each major step, grouping small subtasks into their step rather than giving a row to each tool call. Add one row for every headless coding turn you ran, using its `summary` line, and end with a total row.

After each `ori code -p "<task>"` turn, stdout ends with one human summary line such as `summary  model=<slug>  duration=<n>ms  input=<n> tok  output=<n> tok  context=<n> tok  $<cost>`. Copy one line per turn into the table. Use the served `model=` value; if only the request is known, use `requested-model=` and label the model unresolved. Leave missing cost, duration, tokens, or model as `unmeasured`; never turn an absent value into zero. The eval's candidate and judge spend lines describe eval calls separately, so keep them separate from the coding-turn rows.

## Appendix I: A results table

| Model | Outcome | Cost | Latency | Judge score |
| --- | --- | --- | --- | --- |
| ~anthropic/claude-sonnet-latest | passed | $0.0041 | 3.2s | 0.91 |
| some/cheap-model | failed | $0.0002 | 1.1s | 0.42 |
| some/other-model | unknown | unmeasured | 2.4s | unmeasured |
| another/model | passed | $0.0011 | 2.0s | 0.78 |
| final/model | failed | $0.0007 | 1.8s | 0.36 |

A recommendation reading off that table:

> **Primary: `~anthropic/claude-sonnet-latest`.** Passed all 24 cases, the only candidate that got the refund policy right every time, and the most expensive at $0.0041/run. **Fallback: `some/cheap-model`.** 20x cheaper, half the latency, failed 5 of 24 (invented a 60-day return window twice). Fine for triage, not a final customer reply. **I measured 24 cases from the 893 you supplied**, from all 8 categories and both languages. **I weighted correctness first** because a wrong policy answer costs you a chargeback, and treated cost as a tiebreaker. I did not measure tone against your real support voice, because I had no approved replies to grade against.

## Appendix K: A session cost table

Copy one summary line from each headless coding turn and reprint it as a row:

```text
summary  model=openai/gpt-4.1-mini  duration=1840ms  input=1250 tok  output=340 tok  context=4096 tok  $0.001234
summary  requested-model=google/gemini-2.5-flash  duration=2100ms  input=980 tok  output=280 tok  context=3072 tok
```

| Step | Model | Duration | Cost |
| --- | --- | --- | --- |
| Eval turn | openai/gpt-4.1-mini | 1840ms | $0.001234 |
| Follow-up turn | unresolved: google/gemini-2.5-flash | 2100ms | unmeasured |
| **Total** |  |  | **$0.001234** |

## Appendix L: A surface inventory

<!-- prettier-ignore -->
| surface          | model today                | code                          |
| ---------------- | -------------------------- | ----------------------------- |
| Chat widget      | `openai/gpt-5.4-mini`      | `api/chat/index.py:42`        |
| Ticket triage    | `google/gemini-3-flash`    | `api/triage/logic.py:142`     |
| Refund assistant | `unknown — set at runtime` | `api/refunds/assistant.py:88` |

## Appendix M: Asking for data, and labelling what you invented

Each question is the last thing in its turn and has the same shape: the tag, the question, three options drawn from what you found, and a free-text `Other`. The surface options come straight out of the inventory table:

```text
[surface] I found three places this repo calls a model. Which one should I measure?

1. Chat widget, on openai/gpt-5.4-mini
2. Ticket triage, on google/gemini-3-flash
3. Refund assistant, on the model set at runtime
4. Other: name another surface
```

The data question carries the decline as its third option, so answering it is never a commitment to find a dataset:

```text
[workspace-data] Which real traffic should I point this at? Ten real prompts beat a hundred I make up.

1. The tickets in data/support-tickets.json
2. Ten recent prompts from your ticket export, pasted in
3. Nothing real, write cases from the system prompt and say you wrote them
4. Other: a path, an export, or ten lines pasted in
```

The remaining questions follow the same shape:

- `[workspace-files]` Which files, tests, or related material should I read?
- `[criteria-priority]` Which criterion decides it when two models are close?
- `[evaluation-constraint]` Which limit should the eval hold the candidates to?
- `[candidates]` Run the comparison with this slate and case set, swap a candidate, or stop?
- `[next-step]` Pin the winner, add the eval to CI, do nothing more, or choose `Other` for anything else?

> I found no real usage data, so I wrote 12 cases from your system prompt and tool list. They check the agent does the obvious right thing; they are not evidence it works on your traffic, and 12 invented cases cannot separate two close models.
