---
name: spawn-ori-eval
description: Run the self-contained Ori eval workflow, relay its one question at a time, and return the real eval results.
metadata:
  protocol: ori-eval-spawn-v1
  run_model: openai/gpt-5.6-terra
  judge_model: openai/gpt-5.6-terra
  harness: pi
---

# Spawn Ori Eval

Use the executable that printed this skill. The executable owns the run
directory, task replay, production Ori subprocess, answer/error files, locking,
and summary accounting. Do not write an eval yourself and do not run model calls
outside it.

1. From the repository root run:

   ```bash
   ori-eval-system spawn prepare --request-file <file>
   ```

   Use `--request <text>` only when the request is short. The defaults pin the
   author harness to `pi`, the author model to `openai/gpt-5.6-terra`, and the
   judge model to `openai/gpt-5.6-terra`.

2. If it reports `action-required`, show the existing run summary and ask the
   user whether to resume, archive and start fresh, or stop. Repeat `prepare`
   with `--existing resume`, `--existing archive`, or `--existing stop`.

3. Run:

   ```bash
   ori-eval-system spawn run
   ```

4. Read the JSON response. If its status is `waiting`, print `context` in an
   ordinary message, including any table. Then ask with your own question UI
   using `prompt` as one short sentence and the three labels in `options`,
   keeping free-text `Other`. Do not put a markdown table in the question body.
   Do not answer for the user.

5. Pass the answer back without rewriting it:

   ```bash
   ori-eval-system spawn answer --answer-file <file>
   ```

   If the JSON has `accepted: false`, append nothing and do not restart Ori.
   Respond to the clarification or complaint, then ask the same question again
   through the question UI. Only a reply that answers the open question is
   appended to the task prompt and run again. Repeat steps 4 and 5 until status
   is `completed`.

6. Relay the completed answer, including its results. Relay `costTable` in full
   and the `cheaperRerun` line. Also relay `attemptTotals`. Tell the user the
   scratch workspace is throwaway and may be moved into their repository if they
   want to keep the eval.

Rules:

- Never edit the evaluated repository for this throwaway measurement.
- Never start more than one run process.
- Never bypass `ori auth`, candidate approval, or any question emitted by Ori.
- Never invent a model, result, cost, duration, or answer.
- Do not substitute a harness or model unless the user explicitly requests it;
  any override is persisted and displayed in the run state.
- `unknown` cost is not zero.
- Never write "bakeoff" to the user. Replace it with "model comparison" every
  time you relay, quote, or summarise Ori's text.
- A clarification request or complaint is not an answer. When `accepted` is
  false, append nothing, stay on the same question, and wait.
