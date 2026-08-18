import { Context, Effect, Layer, Ref, Semaphore } from "effect";

import {
  type TestdriveFailsafes,
  TestdriveGuardError,
  type TestdriveLedgerSnapshot
} from "./contracts.js";
import { estimateTestdriveCostUsd, type ResolvedTestdrivePricing } from "./pricing.js";
import type { TestdriveUsage } from "./usage.js";

export type TestdriveReservationInput = Readonly<{
  model: string;
  inputTokens: number;
  outputTokens: number;
  pricing: ResolvedTestdrivePricing;
}>;

export type TestdriveReservation = Readonly<
  TestdriveReservationInput & {
    id: number;
    estimatedCostUsd: number;
  }
>;

type LedgerState = Readonly<{
  nextId: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  unknownMeasurements: number;
  unpricedCalls: number;
  blocked: boolean;
  reservations: ReadonlyMap<number, TestdriveReservation>;
}>;

export interface TestdriveLedgerService {
  readonly reserve: (
    input: TestdriveReservationInput
  ) => Effect.Effect<TestdriveReservation, TestdriveGuardError>;
  readonly reconcile: (
    reservation: TestdriveReservation,
    usage: TestdriveUsage
  ) => Effect.Effect<TestdriveLedgerSnapshot, TestdriveGuardError>;
  readonly markUnknown: (
    reservation: TestdriveReservation
  ) => Effect.Effect<TestdriveLedgerSnapshot>;
  readonly poison: Effect.Effect<TestdriveLedgerSnapshot>;
  readonly snapshot: Effect.Effect<TestdriveLedgerSnapshot>;
}

export class TestdriveLedger extends Context.Service<TestdriveLedger, TestdriveLedgerService>()(
  "@velum-labs/routekit-testkit/TestdriveLedger"
) {}

const snapshotOf = (state: LedgerState): TestdriveLedgerSnapshot => ({
  calls: state.calls,
  activeReservations: state.reservations.size,
  inputTokens: state.inputTokens,
  outputTokens: state.outputTokens,
  estimatedCostUsd: state.estimatedCostUsd,
  estimatedCostUsdStatus: state.unpricedCalls > 0 ? "known-priced-subtotal" : "complete",
  dollarFailsafeStatus: state.unpricedCalls > 0 ? "unavailable-for-unpriced-calls" : "active",
  unknownMeasurements: state.unknownMeasurements,
  unpricedCalls: state.unpricedCalls
});

const activeTotals = (
  state: LedgerState
): Readonly<{ inputTokens: number; outputTokens: number; estimatedCostUsd: number }> => {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  for (const reservation of state.reservations.values()) {
    inputTokens += reservation.inputTokens;
    outputTokens += reservation.outputTokens;
    estimatedCostUsd += reservation.estimatedCostUsd;
  }
  return { inputTokens, outputTokens, estimatedCostUsd };
};

const checkLimit = (
  condition: boolean,
  code: TestdriveGuardError["code"],
  detail: string
): TestdriveGuardError | undefined =>
  condition ? undefined : new TestdriveGuardError({ code, detail });

export const makeTestdriveLedgerLayer = (
  limits: TestdriveFailsafes
): Layer.Layer<TestdriveLedger> =>
  Layer.effect(
    TestdriveLedger,
    Effect.gen(function* () {
      const state = yield* Ref.make<LedgerState>({
        nextId: 1,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        unknownMeasurements: 0,
        unpricedCalls: 0,
        blocked: false,
        reservations: new Map()
      });
      const lock = yield* Semaphore.make(1);
      const reserve: TestdriveLedgerService["reserve"] = (input) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.blocked) {
              return yield* new TestdriveGuardError({
                code: "measurement-missing",
                detail: "egress guard is closed after an unmeasured billed request"
              });
            }
            const active = activeTotals(current);
            const reservation: TestdriveReservation = {
              ...input,
              id: current.nextId,
              estimatedCostUsd: estimateTestdriveCostUsd(
                input.pricing,
                input.inputTokens,
                input.outputTokens
              )
            };
            const failure =
              checkLimit(
                current.calls + 1 <= limits.maxEgressCalls,
                "call-limit",
                `egress call failsafe ${String(limits.maxEgressCalls)} exhausted`
              ) ??
              checkLimit(
                current.inputTokens + active.inputTokens + input.inputTokens <=
                  limits.maxInputTokens,
                "input-token-limit",
                `input token failsafe ${String(limits.maxInputTokens)} exceeded`
              ) ??
              checkLimit(
                current.outputTokens + active.outputTokens + input.outputTokens <=
                  limits.maxOutputTokens,
                "output-token-limit",
                `output token failsafe ${String(limits.maxOutputTokens)} exceeded`
              ) ??
              checkLimit(
                current.estimatedCostUsd + active.estimatedCostUsd + reservation.estimatedCostUsd <=
                  limits.maxEstimatedCostUsd,
                "cost-limit",
                `estimated spend failsafe $${limits.maxEstimatedCostUsd.toFixed(2)} exceeded`
              );
            if (failure !== undefined) return yield* failure;
            const reservations = new Map(current.reservations);
            reservations.set(reservation.id, reservation);
            yield* Ref.set(state, {
              ...current,
              nextId: current.nextId + 1,
              calls: current.calls + 1,
              reservations
            });
            return reservation;
          })
        );
      const reconcile: TestdriveLedgerService["reconcile"] = (reservation, usage) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const reservations = new Map(current.reservations);
            reservations.delete(reservation.id);
            const estimatedCostUsd = estimateTestdriveCostUsd(
              reservation.pricing,
              usage.inputTokens,
              usage.outputTokens
            );
            const next: LedgerState = {
              ...current,
              inputTokens: current.inputTokens + usage.inputTokens,
              outputTokens: current.outputTokens + usage.outputTokens,
              estimatedCostUsd: current.estimatedCostUsd + estimatedCostUsd,
              unpricedCalls: current.unpricedCalls + (reservation.pricing.priced ? 0 : 1),
              reservations
            };
            yield* Ref.set(state, next);
            const failure =
              checkLimit(
                next.inputTokens <= limits.maxInputTokens,
                "input-token-limit",
                `input token failsafe ${String(limits.maxInputTokens)} exceeded`
              ) ??
              checkLimit(
                next.outputTokens <= limits.maxOutputTokens,
                "output-token-limit",
                `output token failsafe ${String(limits.maxOutputTokens)} exceeded`
              ) ??
              checkLimit(
                next.estimatedCostUsd <= limits.maxEstimatedCostUsd,
                "cost-limit",
                `estimated spend failsafe $${limits.maxEstimatedCostUsd.toFixed(2)} exceeded`
              );
            if (failure !== undefined) return yield* failure;
            return snapshotOf(next);
          })
        );
      const markUnknown: TestdriveLedgerService["markUnknown"] = (reservation) =>
        lock.withPermit(
          Ref.modify(state, (current) => {
            const reservations = new Map(current.reservations);
            reservations.delete(reservation.id);
            const next = {
              ...current,
              inputTokens: current.inputTokens + reservation.inputTokens,
              outputTokens: current.outputTokens + reservation.outputTokens,
              estimatedCostUsd: current.estimatedCostUsd + reservation.estimatedCostUsd,
              unknownMeasurements: current.unknownMeasurements + 1,
              unpricedCalls: current.unpricedCalls + (reservation.pricing.priced ? 0 : 1),
              blocked: true,
              reservations
            };
            return [snapshotOf(next), next] as const;
          })
        );
      const poison: TestdriveLedgerService["poison"] = lock.withPermit(
        Ref.modify(state, (current) => {
          const next = {
            ...current,
            unknownMeasurements: current.unknownMeasurements + 1,
            blocked: true
          };
          return [snapshotOf(next), next] as const;
        })
      );
      return TestdriveLedger.of({
        reserve,
        reconcile,
        markUnknown,
        poison,
        snapshot: Ref.get(state).pipe(Effect.map(snapshotOf))
      });
    })
  );
