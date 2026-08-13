# @velum-labs/routekit-eval-contracts

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `8fd8e0554ef8f6d2ff5a03d37dd60c0c40bafca3965de151a4e09ff69e538dbd`

## Root declarations

```ts
export declare const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";
export declare const EVAL_CONTRACT_VERSION: 1;
export declare const EVAL_FORBIDDEN_MODELS: readonly ["auto", "router", "default"];
export declare const EVAL_POLICY: EvalPolicy;
export declare const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
export declare function assertExplicitEvalModel(model: string, role: EvalRole): void;
export declare function isForbiddenEvalModel(model: string): boolean;
export type EvalAttribution = {
export type EvalCase = {
export type EvalCaseResult = {
export type EvalContractVersion = typeof EVAL_CONTRACT_VERSION;
export type EvalEvidence = {
export type EvalPolicy = {
export type EvalRole = "candidate" | "judge";
export type EvalRunResult = {
export type EvalSuiteSpec = {
export type EvalWorkerRequest = {
export type EvalWorkerResponse = {
```
