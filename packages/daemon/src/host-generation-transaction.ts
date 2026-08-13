export type HostGenerationStage = "prepare" | "validate" | "persist" | "commit" | "retire";

/**
 * Host rolling replacement as an explicit prepare/validate/persist/commit/retire
 * transaction. Pre-publication failures roll the candidate back; retirement
 * after commit is best-effort and must not undo the published generation.
 */
export type HostGenerationTransaction<TCandidate, TResult> = {
  onStage?: (stage: HostGenerationStage) => void;
  prepare(): Promise<TCandidate>;
  validate(candidate: TCandidate): Promise<void>;
  persist(candidate: TCandidate): Promise<void> | void;
  commit(candidate: TCandidate): Promise<TResult> | TResult;
  rollback(candidate: TCandidate | undefined, error: unknown): Promise<void>;
  retire(): void | Promise<void>;
};

export async function runHostGenerationTransaction<TCandidate, TResult>(
  transaction: HostGenerationTransaction<TCandidate, TResult>
): Promise<TResult> {
  let candidate: TCandidate | undefined;
  try {
    transaction.onStage?.("prepare");
    candidate = await transaction.prepare();
    transaction.onStage?.("validate");
    await transaction.validate(candidate);
    transaction.onStage?.("persist");
    await transaction.persist(candidate);
    transaction.onStage?.("commit");
    const result = await transaction.commit(candidate);
    try {
      transaction.onStage?.("retire");
      await transaction.retire();
    } catch {
      /* Retirement is best-effort after publication. */
    }
    return result;
  } catch (error) {
    try {
      await transaction.rollback(candidate, error);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "host generation failed and rollback was incomplete"
      );
    }
    throw error;
  }
}
