# @velum-labs/routekit-eval-engine/authoring

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `af9dc6cbf41ac788fb468de00e9b2ae5929047afba69eea0360a6ac85ec08544`

## Root declarations

```ts
export declare const createEvalAuthoring: (runtime: CreateEvalRuntime) => CreateEvalAuthoring;
export declare const createProductionAuthorTurnAdapter: (
export declare const runEvalTool: (input: CreateEvalToolInput) => Promise<CreateEvalToolResult>;
export interface CreateEvalAnswerInput extends CreateEvalRunInput {
export interface CreateEvalAttempt {
export interface CreateEvalAttemptSummary {
export interface CreateEvalAuthorTurnInput {
export interface CreateEvalAuthorTurnResult {
export interface CreateEvalAuthoring {
export interface CreateEvalCredentialInput {
export interface CreateEvalCredentialResult {
export interface CreateEvalPrepareInput {
export interface CreateEvalQuestion {
export interface CreateEvalResult {
export interface CreateEvalRunInput {
export interface CreateEvalRuntime {
export interface CreateEvalState {
export interface CreateEvalStatusInput extends CreateEvalRunInput {}
export interface CreateEvalToolInput {
export interface CreateEvalToolResult {
export interface ProductionAuthorTurnAdapter {
export interface ProductionAuthorTurnAdapterOptions {
export interface ProductionHeadlessAuthorInput extends CreateEvalAuthorTurnInput {
export type CreateEvalAuthorHarness = "pi" | "claude" | "codex";
export type CreateEvalExistingChoice = "resume" | "archive" | "stop";
export type CreateEvalRunStatus =
```
