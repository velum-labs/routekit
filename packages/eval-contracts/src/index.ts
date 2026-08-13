/** Header that marks an eval egress call so the auto-router must not apply. */
export const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";

/** Attribution metadata for candidate and judge calls. */
export const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";

export const EVAL_CONTRACT_VERSION = 1 as const;

export type EvalContractVersion = typeof EVAL_CONTRACT_VERSION;

/** Evaluation must never select the online auto-router. */
export const EVAL_FORBIDDEN_MODELS = ["auto", "router", "default"] as const;

export type EvalRole = "candidate" | "judge";

export type EvalAttribution = {
  purpose: "eval";
  role: EvalRole;
  runId: string;
  caseId: string;
};

export type EvalCase = {
  id: string;
  prompt: string;
  expected?: string;
};

export type EvalSuiteSpec = {
  version: EvalContractVersion;
  id: string;
  candidateModel: string;
  judgeModel: string;
  cases: readonly EvalCase[];
};

export type EvalCaseResult = {
  caseId: string;
  candidateOutput: string;
  judgeOutput?: string;
  passed: boolean;
  error?: string;
};

export type EvalRunResult = {
  version: EvalContractVersion;
  runId: string;
  suiteId: string;
  candidateModel: string;
  judgeModel: string;
  startedAt: string;
  finishedAt: string;
  passed: number;
  failed: number;
  cases: readonly EvalCaseResult[];
};

export type EvalEvidence = {
  version: EvalContractVersion;
  runId: string;
  digest: string;
  publishedAt: string;
};

export type EvalPolicy = {
  version: EvalContractVersion;
  dedicatedToken: true;
  explicitModelIds: true;
  policyBypass: true;
  autoRouterForbidden: true;
  onlineRequestPathIsolated: true;
};

export const EVAL_POLICY: EvalPolicy = {
  version: EVAL_CONTRACT_VERSION,
  dedicatedToken: true,
  explicitModelIds: true,
  policyBypass: true,
  autoRouterForbidden: true,
  onlineRequestPathIsolated: true
};

export type EvalWorkerRequest = {
  version: EvalContractVersion;
  type: "run";
  id: string;
  spec: EvalSuiteSpec;
  gatewayUrl: string;
  token: string;
};

export type EvalWorkerResponse =
  | {
      version: EvalContractVersion;
      type: "result";
      id: string;
      result: EvalRunResult;
    }
  | {
      version: EvalContractVersion;
      type: "error";
      id: string;
      error: string;
    };

export function isForbiddenEvalModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    EVAL_FORBIDDEN_MODELS.includes(normalized as (typeof EVAL_FORBIDDEN_MODELS)[number]) ||
    !model.includes("/")
  );
}

export function assertExplicitEvalModel(model: string, role: EvalRole): void {
  if (isForbiddenEvalModel(model)) {
    throw new Error(`${role} model must be an explicit provider/model id, not ${JSON.stringify(model)}`);
  }
}
