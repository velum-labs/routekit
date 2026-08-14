import { Data } from "effect";

export interface EvalHostMetadata {
  readonly architecture?: string;
  readonly hostname?: string;
  readonly nodeVersion?: string;
  readonly operatingSystem?: string;
  readonly runner?: string;
}

export interface EvalUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly contextTokens?: number;
  readonly costUsd?: number;
}

export type EvalRunRole = "candidate" | "judge";
export type EvalRunOutcome = "failed" | "passed" | "unknown";

export interface EvalTerminalEvent {
  readonly createdAt?: string;
  readonly harness?: string;
  readonly model?: string | null;
  readonly payload?: unknown;
  readonly runId?: string;
  readonly turnId?: string;
  readonly type: string;
}

export interface EvalRunStartLine {
  readonly requestedModel: string;
  readonly role?: EvalRunRole;
  readonly runKey: string;
  readonly suiteId?: string;
  readonly caseId?: string;
  readonly host?: EvalHostMetadata;
}

export interface EvalRunLine {
  readonly model: string;
  readonly runKey?: string;
  readonly role?: EvalRunRole;
  readonly suiteId?: string;
  readonly caseId?: string;
  readonly host?: EvalHostMetadata;
  readonly durationMs?: number;
  readonly eventCounts?: Readonly<Record<string, number>>;
  readonly outputChars?: number;
  readonly terminal?: EvalTerminalEvent;
  readonly toolCalls?: readonly string[];
  readonly usage?: EvalUsage;
}

export interface EvalRunOutcomeLine {
  readonly message?: string;
  readonly outcome: Exclude<EvalRunOutcome, "unknown">;
  readonly runKey: string;
  readonly score?: number;
}

export type EvalResultLine = EvalRunStartLine | EvalRunLine | EvalRunOutcomeLine;

export interface EvalResultRow extends EvalRunLine {
  readonly cutOff: boolean;
  readonly outcome: EvalRunOutcome;
  readonly outcomeDetail?: string;
  readonly score?: number;
}

export type EvalTestStatus = "pass" | "fail" | "skipped";

export interface EvalTestRow {
  readonly durationMs?: number;
  readonly file?: string;
  readonly name: string;
  readonly status: EvalTestStatus;
}

export interface EvalDiscovery {
  readonly searchRoot: string;
  readonly workingDirectory: string;
  readonly files: readonly string[];
}

export interface EvalRunSummary extends EvalDiscovery {
  readonly exitCode: number;
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface EvalDryRunSummary extends EvalDiscovery {
  readonly exitCode: 0;
  readonly fileCount: number;
  readonly testCount: 0;
  readonly tests: readonly EvalTestRow[];
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type EvalEngineEvent =
  | { readonly _tag: "EvalDiscovered"; readonly discovery: EvalDiscovery }
  | {
      readonly _tag: "EvalRunStarted";
      readonly files: readonly string[];
      readonly dryRun: boolean;
    }
  | { readonly _tag: "EvalRunCompleted"; readonly summary: EvalRunSummary }
  | { readonly _tag: "EvalDryRunCompleted"; readonly summary: EvalDryRunSummary };

export interface EvalEngineOptions {
  readonly nodeExecutable: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly defaultTimeoutMs?: number;
}

export interface EvalTargetOptions {
  readonly target: string;
  readonly workingDirectory?: string;
}

export interface EvalExecutionOptions extends EvalTargetOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

export class EvalDiscoveryError extends Data.TaggedError("EvalDiscoveryError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not discover eval files under ${this.path}.`;
  }
}

export class EvalImportError extends Data.TaggedError("EvalImportError")<{
  readonly offences: readonly string[];
}> {
  override get message(): string {
    return `Eval files contain non-portable imports:\n${this.offences.join("\n")}`;
  }
}

export class EvalSpawnError extends Data.TaggedError("EvalSpawnError")<{
  readonly executable: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not start node:test with ${this.executable}.`;
  }
}

export class EvalResultReadError extends Data.TaggedError("EvalResultReadError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not read evaluation output from ${this.path}.`;
  }
}

export class EvalDryRunError extends Data.TaggedError("EvalDryRunError")<{
  readonly files: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  override get message(): string {
    return "node:test could not load every discovered eval without running test bodies.";
  }
}

export type EvalEngineError =
  | EvalDiscoveryError
  | EvalImportError
  | EvalSpawnError
  | EvalResultReadError
  | EvalDryRunError;
