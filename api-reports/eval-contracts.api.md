# @velum-labs/routekit-eval-contracts

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `bca651885d18ea6ac3071c108df7683b7fddf08b39829a0f3a39f482d69ae0ec`

## Root declarations

```ts
declare const InvalidEvalModelError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
export declare class InvalidEvalModelError extends InvalidEvalModelError_base<{
export declare const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";
export declare const EVAL_CONTRACT_VERSION: 2;
export declare const EVAL_FORBIDDEN_MODELS: readonly ["auto", "router", "default"];
export declare const EVAL_POLICY: EvalPolicy;
export declare const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
export declare const EvalAttribution: Schema.Struct<{
export declare const EvalContractVersion: Schema.Literal<2>;
export declare const EvalEngineHost: Schema.Struct<{
export declare const EvalEngineResult: Schema.Struct<{
export declare const EvalEngineRun: Schema.Struct<{
export declare const EvalEngineTerminal: Schema.Struct<{
export declare const EvalEngineTest: Schema.Struct<{
export declare const EvalEvaluatorMetadata: Schema.Struct<{
export declare const EvalOutcome: Schema.Literals<readonly ["failed", "passed", "unknown"]>;
export declare const EvalPolicy: Schema.Struct<{
export declare const EvalRole: Schema.Literals<readonly ["candidate", "judge"]>;
export declare const EvalRunManifest: Schema.Struct<{
export declare const EvalUsage: Schema.Struct<{
export declare const NormalizedEvalObservation: Schema.Struct<{
export declare const StoredEvalObservations: Schema.Struct<{
export declare const StoredEvalRun: Schema.Struct<{
export declare function isForbiddenEvalModel(model: string): boolean;
export declare function validateExplicitEvalModel(model: string, role: EvalRole): Effect.Effect<string, InvalidEvalModelError>;
export type EvalAttribution = typeof EvalAttribution.Type;
export type EvalContractVersion = typeof EvalContractVersion.Type;
export type EvalEngineRun = typeof EvalEngineRun.Type;
export type EvalEvaluatorMetadata = typeof EvalEvaluatorMetadata.Type;
export type EvalOutcome = typeof EvalOutcome.Type;
export type EvalPolicy = typeof EvalPolicy.Type;
export type EvalRole = typeof EvalRole.Type;
export type EvalRunManifest = typeof EvalRunManifest.Type;
export type EvalUsage = typeof EvalUsage.Type;
export type NormalizedEvalObservation = typeof NormalizedEvalObservation.Type;
export type StoredEvalObservations = typeof StoredEvalObservations.Type;
export type StoredEvalRun = typeof StoredEvalRun.Type;
export {};
```
