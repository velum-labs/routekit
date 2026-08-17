# Vercel experiment-platform pilot results

**Date:** August 17, 2026  
**Project:** `velum-labs/routekit-experiments-development`  
**Production URL:** `https://routekit-experiments-development.vercel.app`

## What was verified

The pilot exercised the complete production path:

1. API-token authentication.
2. A content-addressed input upload to private Vercel Blob.
3. Manifest validation and freezing.
4. A required paid-execution approval.
5. A durable Vercel Workflow run.
6. Dispatch through Vercel Queues.
7. Execution in a one-vCPU Vercel Sandbox.
8. Job, attempt, reservation, approval, and run state in Neon Postgres.
9. Immutable output, log, metrics, and Markdown report artifacts in Blob.
10. Authenticated dashboard and artifact access.

The pilot used Vercel's Node 22 image pinned to:

```text
vercel/sandbox/node@sha256:6572e4c113964b1b048aeae7c1c36fd903020aa316cba6879dabe2a08f50f1ed
```

## Successful run

- Experiment: `routekit-vercel-sandbox-pilot-20260817-175640`
- Source commit: `6ddf3722c38680a4d6d73b1dd653f1b02ffa8270`
- Manifest hash: `1c08d227d9b066a463038501e7f42857dbdebda15608e981562a88674caba982`
- Jobs: **1**
- Succeeded: **1**
- Failed: **0**
- Attempts: **1**
- Sandbox command latency: **147 ms**
- End-to-end time from run creation through report completion: **40.7 seconds**
- Provider cost recorded: **$0.00**
- Infrastructure estimate reserved and recorded: **$0.01**
- Infrastructure budget: **$0.02**
- Scope hit@1: **100% (1/1)**
- Area hit@1: **100% (1/1)**
- Area Brier score: **0.0000**

The single-example accuracy figures only validate the reducer and reporting path. They are not a
model-quality result.

## Immutable evidence

- Input hash:
  `9122db3275b6020cc532060b508d894539f052e8ea898ac5bd7564cf92d5c6fb`
- Output hash:
  `f88b976a5a540ab8e12d7eb50840b998e3c573b056e61e57049a1afedd3f54da`
- Log hash:
  `09d29c168b909c32d8e7ebe51e330078de3d38ffa3c9b2a1858ce7dcc30ac717`
- Metrics hash:
  `131e47f45e512e2006e8a246b6c4a7106ee4821377959b98955d510d1b6a95aa`
- Report hash:
  `d8d58dbdd6dee8645c098f52ca1453d0c9f31d658f594dacc970f423f8dd57ad`

## Issue found during the pilot

The first cloud run, `routekit-vercel-sandbox-pilot-20260817-175058`, exposed a polling bug.
The Sandbox command had completed and written its output, but the worker only inspected the
detached command's cached `exitCode`, which remained `null`. The run was cancelled without
charging its reserved infrastructure estimate.

The worker was changed to call `Command.wait()` with a five-second abort signal. A timeout now
means the command is still running; a completed command returns its final exit code and output.
The successful run above verified the fix in production.

## Current limitations

- Hosted-model jobs are intentionally disabled until a dedicated
  `ROUTEKIT_EVAL_TOKEN` and pinned gateway URL are configured.
- The private Vercel Container Registry repository exists, but no custom runner image has been
  pushed because this machine does not have Docker, Podman, or Buildah. The pilot used a
  digest-pinned Vercel-managed image instead.
- Locked-test data remains disabled and must use a separately provisioned evaluator project.
