# @velum-labs/routekit-eval-contracts

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `1a6d21b00502a6c133fc3fc736a95b2cb06fda05f0536a210a933b20b666534b`

## Root declarations

```ts
export declare const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";
export declare const EVAL_CONTRACT_VERSION: 1;
export declare const EVAL_FORBIDDEN_MODELS: readonly ["auto", "router", "default"];
export declare const EVAL_POLICY: EvalPolicy;
export declare const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
export declare const EvalAttribution: Schema.Struct<{
export declare const EvalCase: Schema.Struct<{
export declare const EvalCaseResult: Schema.Struct<{
export declare const EvalContractVersion: Schema.Literal<1>;
export declare const EvalEvidence: Schema.Struct<{
export declare const EvalPolicy: Schema.Struct<{
export declare const EvalRole: Schema.Literals<readonly ["candidate", "judge"]>;
export declare const EvalRunResult: Schema.Struct<{
export declare const EvalSuiteSpec: Schema.Struct<{
export declare const EvalWorkerRequest: Schema.Struct<{
export declare const EvalWorkerResponse: Schema.Union<readonly [Schema.Struct<{
export declare function assertExplicitEvalModel(model: string, role: EvalRole): void;
export declare function isForbiddenEvalModel(model: string): boolean;
export type EvalAttribution = typeof EvalAttribution.Type;
export type EvalCase = typeof EvalCase.Type;
export type EvalCaseResult = typeof EvalCaseResult.Type;
export type EvalContractVersion = typeof EvalContractVersion.Type;
export type EvalEvidence = typeof EvalEvidence.Type;
export type EvalPolicy = typeof EvalPolicy.Type;
export type EvalRole = typeof EvalRole.Type;
export type EvalRunResult = typeof EvalRunResult.Type;
export type EvalSuiteSpec = typeof EvalSuiteSpec.Type;
export type EvalWorkerRequest = typeof EvalWorkerRequest.Type;
export type EvalWorkerResponse = typeof EvalWorkerResponse.Type;
```
